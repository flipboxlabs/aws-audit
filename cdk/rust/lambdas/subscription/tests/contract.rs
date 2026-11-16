//! Replays the subscription fixtures in `contract/fixtures/subscription`: each
//! one's log data is encoded the way CloudWatch Logs delivers it, and the handler
//! must make the fixture's AWS calls given the same answers.

use std::io::Write;

use aws_audit::testing::{Recorder, compare_calls, contract_service, fixtures};
use aws_lambda_events::event::cloudwatch_logs::LogsEvent;
use base64::Engine;
use flate2::Compression;
use flate2::write::GzEncoder;
use lambda_kit::testing::LogCapture;
use serde_json::{Map, Value, json};

/// The Lambda event carrying `logs`: gzipped JSON, base64 encoded.
fn logs_event(logs: &Value) -> LogsEvent {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(logs.to_string().as_bytes()).unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(gzip.finish().unwrap());

    // From text, as the runtime reads it: the decoder borrows its keys, which a
    // Value can't lend
    serde_json::from_str(&json!({ "awslogs": { "data": data } }).to_string()).unwrap()
}

fn fixture(name: &str) -> Value {
    fixtures("subscription")
        .into_iter()
        .find_map(|(found, fixture)| (found == name).then_some(fixture))
        .unwrap_or_else(|| panic!("no subscription fixture {name}"))
}

/// Runs a fixture; the lines logged and how the calls differ from it.
async fn replay(name: &str, fixture: &Value) -> (Vec<Map<String, Value>>, Vec<String>) {
    let calls = fixture["calls"].as_array().unwrap();
    let recorder = Recorder::replaying(calls);
    let service = contract_service(&recorder);
    let event = logs_event(&fixture["logs"]);

    let logs = LogCapture::start();
    subscription::handle(&service, &event.aws_logs.data).await;

    (logs.lines(), compare_calls(name, &recorder.calls(), calls))
}

/// The level and message of each line logged at warn or above.
fn problems(lines: &[Map<String, Value>]) -> Vec<(String, String)> {
    lines
        .iter()
        .filter(|line| !matches!(line["level"].as_str(), Some("INFO" | "DEBUG" | "TRACE")))
        .map(|line| {
            (
                line["level"].as_str().unwrap().to_owned(),
                line["message"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn replays_every_subscription_fixture() {
    let fixtures = fixtures("subscription");
    assert!(
        fixtures.len() >= 5,
        "only {} fixtures found",
        fixtures.len()
    );

    let mut failures = Vec::new();
    for (name, fixture) in &fixtures {
        failures.extend(replay(name, fixture).await.1);
    }

    assert!(
        failures.is_empty(),
        "{} mismatches:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

#[tokio::test(start_paused = true)]
async fn logs_skipped_lines_and_invalid_audits() {
    let (lines, _) = replay(
        "skips-lines-without-an-audit",
        &fixture("skips-lines-without-an-audit"),
    )
    .await;

    let skipped = (
        "WARN".to_owned(),
        "No audit log identifier found in message".to_owned(),
    );
    let invalid = (
        "ERROR".to_owned(),
        "An error was caught trying to save audit item".to_owned(),
    );
    // Not JSON, no _audit and null are skipped; an unknown app and a missing
    // operation are invalid
    assert_eq!(
        problems(&lines),
        [
            skipped.clone(),
            skipped.clone(),
            skipped,
            invalid.clone(),
            invalid
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn logs_a_failed_write() {
    let (lines, _) = replay("storage-error", &fixture("storage-error")).await;

    let problems = problems(&lines);
    assert_eq!(
        problems,
        [(
            "ERROR".to_owned(),
            "An error was caught trying to save audit item".to_owned()
        )]
    );
    let error = lines.iter().find(|line| line["level"] == "ERROR").unwrap();
    assert_eq!(error["id"], "audit-1");
    assert_eq!(error["app"], "App1");
    assert_eq!(error["resourceType"], "Order");
}

#[tokio::test(start_paused = true)]
async fn skips_control_messages() {
    let (lines, failures) = replay("control-message", &fixture("control-message")).await;

    assert!(failures.is_empty(), "{failures:?}");
    assert!(problems(&lines).is_empty(), "{lines:?}");
}

/// One audit's failure doesn't stop the others in its batch, which run at once.
#[tokio::test(start_paused = true)]
async fn stores_each_audit_independently() {
    let recorder = Recorder::answering(|call| {
        let key = call.input["Key"]["SK"]["S"].as_str().unwrap_or_default();
        match (call.command.as_str(), key) {
            ("UpdateItem", "audit-2") => json!({
                "error": { "name": "ProvisionedThroughputExceededException", "message": "Slow down" }
            }),
            ("UpdateItem", _) => json!({
                "output": { "Attributes": { "attempts": { "L": [{ "M": {} }] } } }
            }),
            _ => {
                json!({ "output": { "FailedEntryCount": 0, "Entries": [{ "EventId": "event-1" }] } })
            }
        }
    });
    let service = contract_service(&recorder);

    let messages: Vec<Value> = (1..=3)
        .map(|n| {
            json!({
                "id": format!("event-{n}"),
                "timestamp": 0,
                "message": json!({ "_audit": {
                    "id": format!("audit-{n}"),
                    "operation": "createOrder",
                    "target": { "app": "App1", "type": "Order", "id": format!("order-{n}") },
                }})
                .to_string(),
            })
        })
        .collect();
    let mut logs = fixture("stores-an-audit")["logs"].clone();
    logs["logEvents"] = Value::Array(messages);
    let event = logs_event(&logs);

    let captured = LogCapture::start();
    subscription::handle(&service, &event.aws_logs.data).await;

    let mut stored: Vec<_> = recorder
        .calls()
        .iter()
        .filter(|call| call.command == "PutEvents")
        .map(|call| {
            let detail: Value =
                serde_json::from_str(call.input["Entries"][0]["Detail"].as_str().unwrap()).unwrap();
            detail["audit"]["id"].as_str().unwrap().to_owned()
        })
        .collect();
    stored.sort();
    assert_eq!(stored, ["audit-1", "audit-3"]);

    let failed: Vec<_> = captured
        .lines()
        .into_iter()
        .filter(|line| line["level"] == "ERROR")
        .map(|line| line["id"].clone())
        .collect();
    assert_eq!(failed, [json!("audit-2")]);
}
