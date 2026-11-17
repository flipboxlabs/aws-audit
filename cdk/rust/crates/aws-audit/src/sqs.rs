//! Auditing SQS messages: retries, the trace an EventBridge event carries, and a
//! batch handler that records an audit per message (`AuditBatchProcessor`,
//! `buildAuditFromSQSRecord`, `isRetry` and `getReceiveCount` in the TypeScript
//! SDK). Enabled by the `sqs` feature.

use std::fmt;

use aws_lambda_events::event::sqs::{BatchItemFailure, SqsBatchResponse, SqsEvent, SqsMessage};
use futures_util::future::join_all;
use serde::Deserialize;

use crate::log::{Audits, LogAudit};
use crate::model::{EventBridgeEvent, Status};
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
/// attempt to the same audit. Enable `ReportBatchItemFailures` on the event source
/// mapping for SQS to act on the response.
pub async fn process_batch<E: fmt::Display>(
    audits: &mut Audits,
    batch: &SqsEvent,
    audit: impl Fn(&SqsMessage) -> LogAudit,
    handler: impl AsyncFn(&SqsMessage, &mut LogAudit) -> Result<(), E>,
) -> SqsBatchResponse {
    let handled = join_all(batch.records.iter().map(|message| {
        let mut item = audit(message);
        item.status = Status::Success;
        if item.id.is_none() {
            item.id.clone_from(&message.message_id);
        }

        let handler = &handler;
        async move {
            let result = handler(message, &mut item).await;
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
                item.event = event(message);
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
        let mut audits = Audits::new(Arc::new(AuditConfig::new(["App1"], ["Order"])))
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
        assert_eq!(lines[1]["trace"], "xray");
        assert_eq!(lines[2]["status"], "skip");
    }

    #[tokio::test]
    async fn handles_messages_concurrently_and_reports_in_order() {
        let out = Captured::default();
        let mut audits = Audits::new(Arc::new(AuditConfig::new(["App1"], ["Order"])))
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
