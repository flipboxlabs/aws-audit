//! Replays the fixtures in `contract/fixtures/http/status`: each request must make
//! the fixture's AWS calls and, given the same answers, answer the same response.

use std::sync::Arc;

use aws_audit::testing::{Recorder, compare_calls, contract_config, contract_service, fixtures};
use aws_audit_http::testing::{answer, check_response_schema, compare_response, request};
use lambda_kit::testing::LogCapture;
use serde_json::Value;
use status::{State, router};

/// Runs a fixture; its answer, the lines logged, and how it differs from the fixture.
async fn replay(name: &str, fixture: &Value) -> (Value, Vec<String>) {
    let calls = fixture["calls"].as_array().unwrap();
    let recorder = Recorder::replaying(calls);
    let router = router(State {
        config: Arc::new(contract_config()),
        service: contract_service(&recorder),
    });

    let answer = answer(&router.handle(request(fixture)).await);

    let mut failures = compare_calls(name, &recorder.calls(), calls);
    failures.extend(compare_response(name, &answer, &fixture["response"]));
    if answer["statusCode"] == 200 {
        failures.extend(check_response_schema(name, "status", &answer["body"]));
    }
    (answer, failures)
}

#[tokio::test(start_paused = true)]
async fn replays_every_status_fixture() {
    let fixtures = fixtures("http/status");
    assert!(
        fixtures.len() >= 8,
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
async fn logs_a_storage_failure() {
    let (_, fixture) = fixtures("http/status")
        .into_iter()
        .find(|(name, _)| name == "storage-error")
        .unwrap();

    let logs = LogCapture::start();
    replay("storage-error", &fixture).await;

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
    let fixture = serde_json::json!({
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

    let (answer, _) = replay("invalid", &fixture).await;

    let paths: Vec<&Value> = answer["body"]["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| &issue["path"])
        .collect();
    assert_eq!(
        paths,
        [
            &serde_json::json!(["path", "status"]),
            &serde_json::json!(["query", "pagination[pageSize]"]),
            &serde_json::json!(["query", "filter[app]"]),
            &serde_json::json!(["query", "filter[resourceType]"]),
        ]
    );
}
