//! Replays the fixtures in `contract/fixtures/http/rerun`: the stored event must
//! be sent again exactly as stored, once, to the bus it recorded or the audit
//! event bus, and only for a rerunable audit of the addressed item.

use std::sync::Arc;

use aws_audit::testing::{
    Recorder, contract_config, contract_event_bus, contract_service, fixtures,
};
use aws_audit_http::testing::{replay, replay_fixtures};
use lambda_kit::http::Router;
use lambda_kit::testing::LogCapture;
use rerun::{RerunBuses, State, router};
use serde_json::{Value, json};

fn contract_router(recorder: &Arc<Recorder>) -> Router<State> {
    router(State {
        config: Arc::new(contract_config()),
        service: contract_service(recorder),
        events: contract_event_bus(recorder),
        buses: contract_buses(),
    })
}

/// The buses the fixtures may rerun to: one in the Lambda's account, and one in
/// another.
fn contract_buses() -> RerunBuses {
    RerunBuses::new(
        "123456789012",
        "us-east-1",
        [
            "arn:aws:events:us-east-1:123456789012:event-bus/TEST-Global",
            "arn:aws:events:us-east-1:210987654321:event-bus/TEST-Shared",
        ],
    )
}

fn fixture(name: &str) -> Value {
    fixtures("http/rerun")
        .into_iter()
        .find_map(|(found, fixture)| (found == name).then_some(fixture))
        .unwrap_or_else(|| panic!("no rerun fixture {name}"))
}

#[tokio::test(start_paused = true)]
async fn replays_every_rerun_fixture() {
    replay_fixtures("http/rerun", contract_router).await;
}

#[test]
fn resolves_an_allowed_bus_by_name_in_its_own_account_or_by_arn() {
    let buses = contract_buses();
    let own = "arn:aws:events:us-east-1:123456789012:event-bus/TEST-Global";
    let shared = "arn:aws:events:us-east-1:210987654321:event-bus/TEST-Shared";

    assert_eq!(buses.resolve("TEST-Global"), Some(own));
    assert_eq!(buses.resolve(own), Some(own));
    assert_eq!(buses.resolve(shared), Some(shared));
    // A name is a bus in the Lambda's own account, as PutEvents reads it
    assert_eq!(buses.resolve("TEST-Shared"), None);
    assert_eq!(buses.resolve("TEST-Other"), None);
    assert_eq!(
        buses.resolve("arn:aws:events:us-east-1:123456789012:event-bus/TEST-Shared"),
        None
    );
    assert_eq!(RerunBuses::default().resolve("TEST-Global"), None);

    // PutEvents doesn't reach another region's bus
    let other_region = "arn:aws:events:eu-west-1:123456789012:event-bus/TEST-Global";
    let buses = RerunBuses::new("123456789012", "us-east-1", [other_region]);
    assert_eq!(buses.resolve(other_region), None);
    assert_eq!(buses.resolve("TEST-Global"), None);
}

#[tokio::test(start_paused = true)]
async fn logs_a_rejected_event() {
    let logs = LogCapture::start();

    let replay = replay("rejected", &fixture("rejected"), contract_router).await;

    assert!(replay.failures.is_empty(), "{:?}", replay.failures);
    let errors: Vec<_> = logs
        .lines()
        .into_iter()
        .filter(|line| line["level"] == "ERROR")
        .collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0]["message"], "Unable to rerun the event");
    assert!(
        errors[0]["failedEntries"]
            .as_str()
            .unwrap()
            .contains("ThrottlingException"),
        "{:?}",
        errors[0]
    );
}

#[tokio::test(start_paused = true)]
async fn refuses_an_event_without_a_detail_object() {
    // PutEvents fails an entry without a detail, or with one that isn't a JSON object
    for detail in [None, Some(r#""text""#), Some("[1]")] {
        let mut fixture = fixture("sent");
        let event = fixture["calls"][0]["output"]["Item"]["event"]["M"]
            .as_object_mut()
            .unwrap();
        match detail {
            Some(detail) => event.insert("detail".to_owned(), json!({ "S": detail })),
            None => event.remove("detail"),
        };
        fixture["calls"].as_array_mut().unwrap().truncate(1);
        fixture["response"] = fixture_response("not-rerunable");

        let replay = replay("refused-detail", &fixture, contract_router).await;

        assert!(
            replay.failures.is_empty(),
            "{detail:?}: {:?}",
            replay.failures
        );
    }
}

fn fixture_response(name: &str) -> Value {
    fixture(name)["response"].clone()
}

#[tokio::test(start_paused = true)]
async fn answers_500_when_put_events_fails() {
    let rejected = fixture("rejected");
    let mut fixture = fixture("sent");
    fixture["calls"][1]["output"] = Value::Null;
    fixture["calls"][1]["error"] = json!({ "name": "InternalException", "message": "Boom" });
    fixture["response"] = rejected["response"].clone();

    let replay = replay("put-events-failed", &fixture, contract_router).await;

    assert!(replay.failures.is_empty(), "{:?}", replay.failures);
}
