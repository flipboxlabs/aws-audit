//! Auditing SQS messages: retries, the trace an EventBridge event carries, the
//! audit a rerun's event reruns, and a batch handler that records an audit per
//! message (`AuditBatchProcessor`, `buildAuditFromSQSRecord`, `getRerunAuditId`,
//! `isRetry` and `getReceiveCount` in the TypeScript SDK). Enabled by the `sqs`
//! feature.

use std::fmt;

use aws_lambda_events::event::sqs::{BatchItemFailure, SqsBatchResponse, SqsEvent, SqsMessage};
use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::Value;

use crate::log::{Audits, LogAudit};
use crate::model::{EventBridgeEvent, Status};
use crate::rerun::{RESOURCE_PREFIX, RerunOf};
use crate::trace::increment_trace_stage;

/// How many times the message has been delivered (`ApproximateReceiveCount`): 1 on
/// the first delivery.
pub fn receive_count(message: &SqsMessage) -> Option<u32> {
    message
        .attributes
        .get("ApproximateReceiveCount")
        .and_then(|count| count.parse().ok())
}

/// Whether the message was delivered before.
pub fn is_retry(message: &SqsMessage) -> bool {
    receive_count(message).is_some_and(|count| count > 1)
}

/// The EventBridge event a message's body holds, when an EventBridge rule sent it.
/// What a JSON body holds of one is kept for debugging, even when it can't be
/// re-sent ([`EventBridgeEvent::is_resendable`]).
pub fn event(message: &SqsMessage) -> Option<EventBridgeEvent> {
    serde_json::from_str(message.body.as_deref()?).ok()
}

/// The trace an audit of the message continues: the trace in the event's
/// `detail.transaction.trace`, one stage further.
pub fn trace(message: &SqsMessage) -> Option<String> {
    #[derive(Deserialize)]
    struct Body {
        detail: Option<Detail>,
    }
    #[derive(Deserialize)]
    struct Detail {
        transaction: Option<Transaction>,
    }
    #[derive(Deserialize)]
    struct Transaction {
        trace: Option<String>,
    }

    let body: Body = serde_json::from_str(message.body.as_deref()?).ok()?;
    let trace = body.detail?.transaction?.trace?;
    (!trace.is_empty()).then(|| increment_trace_stage(&trace))
}

/// The audit the message's event reruns, when the rerun Lambda sent it: named in
/// the event's `resources`.
pub fn rerun_of(message: &SqsMessage) -> Option<RerunOf> {
    #[derive(Deserialize)]
    struct Body {
        resources: Option<Vec<Value>>,
    }

    // Most messages aren't reruns: parse only one that may be
    let body = message.body.as_deref()?;
    if !body.contains(RESOURCE_PREFIX) {
        return None;
    }
    let body: Body = serde_json::from_str(body).ok()?;
    RerunOf::from_resources(body.resources?.iter().filter_map(Value::as_str))
}

/// The id `audit` takes when the message's event reruns its audit: the rerun
/// audit's, when `audit` has the same tenant, target and operation. Logged under
/// it, and with [`LogAudit::rerun`] set, the outcome is an attempt of that audit
/// tagged `rerun`. The event's other rules' audits don't match, and keep their
/// own ids.
pub fn rerun_audit_id(message: &SqsMessage, audit: &LogAudit) -> Option<String> {
    rerun_id(rerun_of(message).as_ref(), audit)
}

fn rerun_id(rerun: Option<&RerunOf>, audit: &LogAudit) -> Option<String> {
    rerun
        .filter(|rerun| rerun.matches(audit.tenant_id.as_deref(), &audit.target, &audit.operation))
        .map(|rerun| rerun.id.clone())
}

/// Gives an audit without an id of its own the rerun audit's when it matches,
/// tagged `rerun`, or else the message's.
fn assign_id(message: &SqsMessage, rerun: Option<&RerunOf>, audit: &mut LogAudit) {
    let id = rerun_id(rerun, audit);
    audit.rerun = id.is_some().then_some(true);
    audit.id = id.or_else(|| message.message_id.clone());
}

/// `audit`, continuing the message's trace when it has none of its own
/// (`buildAuditFromSQSRecord`).
pub fn audit_for(message: &SqsMessage, mut audit: LogAudit) -> LogAudit {
    if audit.trace.as_deref().is_none_or(str::is_empty) {
        audit.trace = trace(message);
    }
    audit
}

/// Handles each message of a batch and records an audit of it, reporting the
/// messages that failed so SQS retries only those (`AuditBatchProcessor`).
///
/// `audit` builds a message's audit; `handler` processes the message and may change
/// the audit, e.g. its message or status. Messages are handled concurrently, as
/// Powertools' `BatchProcessor` does by default, so don't use this for a FIFO queue,
/// whose messages must be handled in order. Audits and failures are reported in
/// message order.
///
/// - A handled message is audited as a success, unless `handler` set another
///   status, without its event.
/// - A failed message is audited as a failure, with its event so it can be re-sent,
///   the error appended to the message, and the error.
///
/// An audit without an id takes the message id, so a retried message adds an
/// attempt to the same audit; or, when the message's event reruns an audit it
/// matches ([`rerun_audit_id`]), that audit's id, so the rerun's outcome is an
/// attempt of it, tagged `rerun`. The handler sees the id the audit takes, and
/// the audit is matched again as the handler leaves it, unless the handler set
/// an id itself. Enable `ReportBatchItemFailures` on the event source
/// mapping for SQS to act on the response.
///
/// A failure's event records no bus, so a rerun sends it to the audit event bus;
/// [`process_batch_from_bus`] records the bus the messages came from.
pub async fn process_batch<E: fmt::Display>(
    audits: &mut Audits,
    batch: &SqsEvent,
    audit: impl Fn(&SqsMessage) -> LogAudit,
    handler: impl AsyncFn(&SqsMessage, &mut LogAudit) -> Result<(), E>,
) -> SqsBatchResponse {
    process(None, audits, batch, audit, handler).await
}

/// [`process_batch`] for messages an EventBridge rule on `event_bus_name` sent: a
/// failure's event records the bus, by name or ARN, so a rerun puts it on that bus
/// again (`AuditBatchProcessor`'s `eventBusName` option). Name a bus in another
/// account than the audit stack's by ARN.
pub async fn process_batch_from_bus<E: fmt::Display>(
    event_bus_name: &str,
    audits: &mut Audits,
    batch: &SqsEvent,
    audit: impl Fn(&SqsMessage) -> LogAudit,
    handler: impl AsyncFn(&SqsMessage, &mut LogAudit) -> Result<(), E>,
) -> SqsBatchResponse {
    process(Some(event_bus_name), audits, batch, audit, handler).await
}

async fn process<E: fmt::Display>(
    event_bus_name: Option<&str>,
    audits: &mut Audits,
    batch: &SqsEvent,
    audit: impl Fn(&SqsMessage) -> LogAudit,
    handler: impl AsyncFn(&SqsMessage, &mut LogAudit) -> Result<(), E>,
) -> SqsBatchResponse {
    let handled = join_all(batch.records.iter().map(|message| {
        let rerun = rerun_of(message);
        let mut item = audit(message);
        item.status = Status::Success;
        let own_id = item.id.is_some();
        if !own_id {
            assign_id(message, rerun.as_ref(), &mut item);
        }

        let handler = &handler;
        async move {
            let assigned = item.id.clone();
            let result = handler(message, &mut item).await;
            // Matched again as the handler left the audit, unless it set an id
            if !own_id && item.id == assigned {
                assign_id(message, rerun.as_ref(), &mut item);
            }
            (message, item, result)
        }
    }))
    .await;

    let mut response = SqsBatchResponse::default();
    for (message, mut item, result) in handled {
        match result {
            Ok(()) => item.event = None,
            Err(error) => {
                let error = error.to_string();
                item.status = Status::Fail;
                item.event = event(message).map(|mut event| {
                    // An empty name is none, as in the TypeScript SDK
                    event.event_bus_name = event_bus_name
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned);
                    event
                });
                item.append_message(&error);
                item.error = Some(error);

                let mut failure = BatchItemFailure::default();
                failure.item_identifier = message.message_id.clone().unwrap_or_default();
                response.batch_item_failures.push(failure);
            }
        }

        // An audit naming an unknown app or type is the caller's bug; it shouldn't
        // fail the message too
        if let Err(invalid) = audits.add(item) {
            eprintln!("{invalid}");
        }
    }

    response
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{Value, json};

    use super::*;
    use crate::config::AuditConfig;
    use crate::model::ResourceReference;

    fn message(id: &str, body: Value, receive_count: &str) -> SqsMessage {
        serde_json::from_value(json!({
            "messageId": id,
            "body": body.to_string(),
            "attributes": { "ApproximateReceiveCount": receive_count },
        }))
        .unwrap()
    }

    fn event_body(trace: Option<&str>) -> Value {
        json!({
            "source": "orders",
            "detail-type": "OrderCreated",
            "detail": { "orderId": "order-1", "transaction": { "trace": trace } },
        })
    }

    #[test]
    fn counts_deliveries() {
        let first = message("m-1", json!({}), "1");
        let second = message("m-2", json!({}), "2");

        assert_eq!(receive_count(&first), Some(1));
        assert!(!is_retry(&first));
        assert!(is_retry(&second));
        assert!(!is_retry(&SqsMessage::default()));
    }

    #[test]
    fn continues_the_events_trace() {
        let traced = message("m-1", event_body(Some("trace-1:2")), "1");
        let unstaged = message("m-2", event_body(Some("trace-1")), "1");

        assert_eq!(trace(&traced).as_deref(), Some("trace-1:3"));
        assert_eq!(trace(&unstaged).as_deref(), Some("trace-1:2"));
        for body in [event_body(None), json!({}), json!("text"), json!([1])] {
            assert_eq!(trace(&message("m-3", body.clone(), "1")), None, "{body}");
        }
    }

    #[test]
    fn keeps_an_audits_own_trace() {
        let traced = message("m-1", event_body(Some("trace-1:2")), "1");
        let target = ResourceReference::new("App1", "Order");

        let audit = audit_for(&traced, LogAudit::new("op", target.clone()));
        let own = audit_for(
            &traced,
            LogAudit::new("op", target.clone()).with_trace("own"),
        );
        let empty = audit_for(&traced, LogAudit::new("op", target).with_trace(""));

        assert_eq!(audit.trace.as_deref(), Some("trace-1:3"));
        assert_eq!(own.trace.as_deref(), Some("own"));
        assert_eq!(empty.trace.as_deref(), Some("trace-1:3"));
    }

    #[test]
    fn reads_the_event() {
        let event = event(&message("m-1", event_body(None), "1")).unwrap();

        assert_eq!(event.source.as_deref(), Some("orders"));
        assert_eq!(event.detail_type.as_deref(), Some("OrderCreated"));
        assert_eq!(
            event.detail.as_deref(),
            Some(r#"{"orderId":"order-1","transaction":{"trace":null}}"#)
        );
    }

    #[test]
    fn keeps_what_a_body_holds_of_an_event_and_reads_none_from_one_that_isnt_json() {
        let partial = event(&message("m-1", json!({ "detail": { "orderId": 1 } }), "1")).unwrap();
        assert_eq!(partial.detail.as_deref(), Some(r#"{"orderId":1}"#));
        assert!(!partial.is_resendable());

        assert_eq!(event(&message("m-1", json!("text"), "1")), None);
        let mut text = message("m-1", json!({}), "1");
        text.body = Some("hello".to_owned());
        assert_eq!(event(&text), None);
    }

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn audits_each_message_and_reports_failures() {
        let out = Captured::default();
        let mut audits = Audits::new(Arc::new(AuditConfig::new([("App1", ["Order"])])))
            .with_writer(out.clone())
            .with_disabled(false)
            .with_trace_id("xray");
        let mut batch = SqsEvent::default();
        batch.records = vec![
            message("m-1", event_body(Some("trace-1:1")), "1"),
            message("m-2", event_body(None), "2"),
            message("m-3", event_body(None), "1"),
        ];

        let response = process_batch(
            &mut audits,
            &batch,
            |message| {
                audit_for(
                    message,
                    LogAudit::new("processOrder", ResourceReference::new("App1", "Order"))
                        .with_message("Processing"),
                )
            },
            async |message: &SqsMessage, audit: &mut LogAudit| match message.message_id.as_deref() {
                Some("m-2") => Err("Boom"),
                Some("m-3") => {
                    audit.status = Status::Skip;
                    Ok(())
                }
                _ => Ok(()),
            },
        )
        .await;
        audits.publish();

        let failures: Vec<_> = response
            .batch_item_failures
            .iter()
            .map(|failure| failure.item_identifier.as_str())
            .collect();
        assert_eq!(failures, ["m-2"]);

        let lines: Vec<Value> = String::from_utf8(out.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["_audit"].clone())
            .collect();
        assert_eq!(
            lines[0],
            json!({
                "id": "m-1",
                "operation": "processOrder",
                "tier": 2,
                "status": "success",
                "target": { "app": "App1", "type": "Order" },
                "message": "Processing",
                "trace": "trace-1:2",
            })
        );
        assert_eq!(lines[1]["status"], "fail");
        assert_eq!(lines[1]["message"], "Processing Boom");
        assert_eq!(lines[1]["error"], "Boom");
        assert_eq!(lines[1]["event"]["detail-type"], "OrderCreated");
        assert_eq!(lines[1]["event"].get("eventBusName"), None);
        assert_eq!(lines[1]["trace"], "xray");
        assert_eq!(lines[2]["status"], "skip");
    }

    #[tokio::test]
    async fn records_the_bus_with_a_failures_event() {
        let out = Captured::default();
        let mut audits = Audits::new(Arc::new(AuditConfig::new([("App1", ["Order"])])))
            .with_writer(out.clone())
            .with_disabled(false);
        let mut batch = SqsEvent::default();
        batch.records = vec![
            message("m-1", event_body(None), "1"),
            message("m-2", event_body(None), "1"),
        ];

        let failing =
            async |message: &SqsMessage, _: &mut LogAudit| match message.message_id.as_deref() {
                Some("m-2") => Err("Boom"),
                _ => Ok(()),
            };
        let audit =
            |_: &SqsMessage| LogAudit::new("processOrder", ResourceReference::new("App1", "Order"));
        process_batch_from_bus("PROD-Global", &mut audits, &batch, audit, failing).await;
        // An empty name is none
        process_batch_from_bus("", &mut audits, &batch, audit, failing).await;
        audits.publish();

        let lines: Vec<Value> = String::from_utf8(out.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["_audit"].clone())
            .collect();
        assert_eq!(lines[0].get("event"), None);
        assert_eq!(lines[1]["event"]["eventBusName"], "PROD-Global");
        assert_eq!(lines[1]["event"]["source"], "orders");
        assert_eq!(lines[3]["event"]["source"], "orders");
        assert_eq!(lines[3]["event"].get("eventBusName"), None);
    }

    fn rerun_body(resources: Value) -> Value {
        let mut body = event_body(None);
        body["resources"] = resources;
        body
    }

    const RERUN: &str = r#"aws-audit:rerun:{"id":"audit-1","target":{"app":"App1","type":"Order","id":"order-1"},"operation":"processOrder"}"#;

    #[test]
    fn reads_the_audit_a_rerun_reruns() {
        let rerun = message(
            "m-1",
            rerun_body(json!(["arn:aws:s3:::bucket", RERUN])),
            "1",
        );
        let order = |id: &str| ResourceReference::new("App1", "Order").with_id(id);

        assert_eq!(rerun_of(&rerun).unwrap().id, "audit-1");
        assert_eq!(
            rerun_audit_id(&rerun, &LogAudit::new("processOrder", order("order-1"))).as_deref(),
            Some("audit-1")
        );
        // Another rule's audit of the same event
        assert_eq!(
            rerun_audit_id(&rerun, &LogAudit::new("summarize", order("order-1"))),
            None
        );
        assert_eq!(
            rerun_audit_id(&rerun, &LogAudit::new("processOrder", order("order-2"))),
            None
        );
        for body in [
            event_body(None),
            rerun_body(json!("text")),
            rerun_body(json!([1])),
        ] {
            assert_eq!(rerun_of(&message("m-2", body.clone(), "1")), None, "{body}");
        }
    }

    #[tokio::test]
    async fn logs_a_reruns_outcome_under_the_audit_it_reruns() {
        let out = Captured::default();
        let mut audits = Audits::new(Arc::new(AuditConfig::new([("App1", ["Order"])])))
            .with_writer(out.clone())
            .with_disabled(false);
        let mut batch = SqsEvent::default();
        batch.records = vec![
            message("m-1", rerun_body(json!([RERUN])), "1"),
            message("m-2", rerun_body(json!([RERUN])), "1"),
            message("m-3", event_body(None), "1"),
            message("m-4", rerun_body(json!([RERUN])), "1"),
            message("m-5", rerun_body(json!([RERUN])), "1"),
        ];
        let seen = Mutex::new(Vec::new());

        let response = process_batch(
            &mut audits,
            &batch,
            |message| {
                let order = ResourceReference::new("App1", "Order");
                match message.message_id.as_deref() {
                    // Its own id stays
                    Some("m-2") => {
                        LogAudit::new("processOrder", order.with_id("order-1")).with_id("own")
                    }
                    // Its resource is known once handled
                    Some("m-4") => LogAudit::new("processOrder", order),
                    _ => LogAudit::new("processOrder", order.with_id("order-1")),
                }
            },
            async |message: &SqsMessage, audit: &mut LogAudit| {
                seen.lock().unwrap().push(audit.id.clone());
                match message.message_id.as_deref() {
                    Some("m-1") => Err("Boom"),
                    Some("m-4") => {
                        audit.target.id = Some("order-1".into());
                        Ok(())
                    }
                    // Another operation than the rerun audit's
                    Some("m-5") => {
                        audit.operation = "summarize".to_owned();
                        Ok(())
                    }
                    _ => Ok(()),
                }
            },
        )
        .await;
        audits.publish();

        // SQS retries the message by its own id
        assert_eq!(response.batch_item_failures[0].item_identifier, "m-1");
        // The handler sees the id the audit takes, as far as it's known
        let seen: Vec<_> = seen.into_inner().unwrap().into_iter().flatten().collect();
        assert_eq!(seen, ["audit-1", "own", "m-3", "m-4", "audit-1"]);
        let lines: Vec<Value> = String::from_utf8(out.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| {
                let audit = &serde_json::from_str::<Value>(line).unwrap()["_audit"];
                json!([audit["id"], audit.get("rerun")])
            })
            .collect();
        assert_eq!(
            lines,
            [
                json!(["audit-1", true]),
                json!(["own", null]),
                json!(["m-3", null]),
                json!(["audit-1", true]),
                json!(["m-5", null]),
            ]
        );
    }

    #[tokio::test]
    async fn handles_messages_concurrently_and_reports_in_order() {
        let out = Captured::default();
        let mut audits = Audits::new(Arc::new(AuditConfig::new([("App1", ["Order"])])))
            .with_writer(out.clone())
            .with_disabled(false);
        let mut batch = SqsEvent::default();
        batch.records = (1..=3)
            .map(|n| message(&format!("m-{n}"), json!({}), "1"))
            .collect();

        // Every handler waits for the others: handled one at a time, none finishes
        let barrier = tokio::sync::Barrier::new(batch.records.len());
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            process_batch(
                &mut audits,
                &batch,
                |_| LogAudit::new("processOrder", ResourceReference::new("App1", "Order")),
                async |message: &SqsMessage, _: &mut LogAudit| {
                    barrier.wait().await;
                    match message.message_id.as_deref() {
                        Some("m-1" | "m-3") => Err("Boom"),
                        _ => Ok(()),
                    }
                },
            ),
        )
        .await
        .expect("the messages are handled concurrently");
        audits.publish();

        let failures: Vec<_> = response
            .batch_item_failures
            .iter()
            .map(|failure| failure.item_identifier.as_str())
            .collect();
        assert_eq!(failures, ["m-1", "m-3"]);

        let ids: Vec<String> = String::from_utf8(out.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap()["_audit"]["id"].to_string())
            .collect();
        assert_eq!(ids, [r#""m-1""#, r#""m-2""#, r#""m-3""#]);
    }
}
