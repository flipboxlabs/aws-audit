//! Replays the fixtures in `contract/fixtures/http/status`: each request must make
//! the fixture's AWS calls and, given the same answers, answer the same response.

use std::sync::Arc;

use aws_audit::testing::{Recorder, contract_config, contract_service, fixtures};
use aws_audit_http::testing::{replay, replay_fixtures};
use lambda_kit::http::Router;
use lambda_kit::testing::LogCapture;
use serde_json::json;
use status::{State, router};

fn contract_router(recorder: &Arc<Recorder>) -> Router<State> {
    router(State {
        config: Arc::new(contract_config()),
        service: contract_service(recorder),
    })
}

#[tokio::test(start_paused = true)]
async fn replays_every_status_fixture() {
    replay_fixtures("http/status", contract_router).await;
}

#[tokio::test(start_paused = true)]
async fn logs_a_storage_failure() {
    let (name, fixture) = fixtures("http/status")
        .into_iter()
        .find(|(name, _)| name == "storage-error")
        .unwrap();

    let logs = LogCapture::start();
    replay(&name, &fixture, contract_router).await;

    let errors: Vec<_> = logs
        .lines()
        .into_iter()
        .filter(|line| line["level"] == "ERROR")
        .map(|line| line["message"].as_str().unwrap().to_owned())
        .collect();
    assert!(errors.contains(&"Unhandled error".to_owned()), "{errors:?}");
}

#[tokio::test(start_paused = true)]
async fn reports_every_invalid_input_at_once() {
    let fixture = json!({
        "route": "GET /status/{status}",
        "request": {
            "method": "GET",
            "path": "/status/unknown",
            "query": {
                "pagination[pageSize]": "0",
                "filter[app]": "Nope",
                "filter[resourceType]": "Nope",
            },
        },
        "calls": [],
    });

    let replay = replay("invalid", &fixture, contract_router).await;

    let paths: Vec<_> = replay.answer["body"]["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["path"].clone())
        .collect();
    assert_eq!(
        paths,
        [
            json!(["path", "status"]),
            json!(["query", "pagination[pageSize]"]),
            json!(["query", "filter[app]"]),
            json!(["query", "filter[resourceType]"]),
        ]
    );
}
