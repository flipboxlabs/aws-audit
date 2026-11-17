//! Replays the fixtures in `contract/fixtures/http/rerun`: the stored event must
//! be sent again exactly as stored, once, and only for a rerunable audit of the
//! addressed item.

use std::sync::Arc;

use aws_audit::testing::{
    Recorder, contract_config, contract_event_bus, contract_service, fixtures,
};
use aws_audit_http::testing::{replay, replay_fixtures};
use lambda_kit::http::Router;
use lambda_kit::testing::LogCapture;
use rerun::{State, router};
use serde_json::{Value, json};

fn contract_router(recorder: &Arc<Recorder>) -> Router<State> {
    router(State {
        config: Arc::new(contract_config()),
        service: contract_service(recorder),
        events: contract_event_bus(recorder),
    })
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
async fn sends_an_event_without_a_detail_without_one() {
    let mut fixture = fixture("sent");
    let item = &mut fixture["calls"][0]["output"]["Item"];
    item["event"]["M"].as_object_mut().unwrap().remove("detail");
    fixture["calls"][1]["input"]["Entries"][0]
        .as_object_mut()
        .unwrap()
        .remove("Detail");

    let replay = replay("sent-without-detail", &fixture, contract_router).await;

    assert!(replay.failures.is_empty(), "{:?}", replay.failures);
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
