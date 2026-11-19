//! Replays the fixtures in `contract/fixtures/http/objects`.

use std::sync::Arc;

use aws_audit::testing::{Recorder, contract_config, contract_service};
use aws_audit_http::testing::{replay, replay_fixtures};
use lambda_kit::http::Router;
use objects::{State, router};
use serde_json::{Value, json};

fn contract_router(recorder: &Arc<Recorder>) -> Router<State> {
    router(State {
        config: Arc::new(contract_config()),
        service: contract_service(recorder),
    })
}

#[tokio::test(start_paused = true)]
async fn replays_every_objects_fixture() {
    replay_fixtures("http/objects", contract_router).await;
}

/// The paths of the issues a 422 for `path`, with a bad page size, reports.
async fn issue_paths(path: &str) -> Vec<Value> {
    let fixture = json!({
        "route": "GET /apps/{app}/objects/{object}/{item}",
        "request": {
            "method": "GET",
            "path": path,
            "query": { "pagination[pageSize]": "0" },
        },
        "calls": [],
    });
    let replay = replay("invalid", &fixture, contract_router).await;
    assert_eq!(replay.answer["statusCode"], 422);
    replay.answer["body"]["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|issue| issue["path"].clone())
        .collect()
}

/// Every invalid input is reported, except an object of an app that isn't one, as
/// the app's types are unknown.
#[tokio::test(start_paused = true)]
async fn reports_every_invalid_input() {
    assert_eq!(
        issue_paths("/apps/App1/objects/Nope/order-1").await,
        [
            json!(["path", "object"]),
            json!(["query", "pagination[pageSize]"]),
        ]
    );
    assert_eq!(
        issue_paths("/apps/Nope/objects/Nope/order-1").await,
        [
            json!(["path", "app"]),
            json!(["query", "pagination[pageSize]"]),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn finds_a_numeric_target_id_by_its_string_form() {
    let item = json!({
        "PK": { "S": "-#App1#Order#audit-1" },
        "SK": { "S": "audit" },
        "id": { "S": "audit-1" },
        "status": { "S": "success" },
        "tier": { "N": "2" },
        "operation": { "S": "createOrder" },
        "target": { "M": {
            "app": { "S": "App1" },
            "type": { "S": "Order" },
            "id": { "N": "42" },
        }},
        "createdAt": { "S": "2026-01-02T03:04:05.678Z" },
        "updatedAt": { "S": "2026-01-02T03:04:05.678Z" },
    });
    let fixture = |item_path: &str| {
        json!({
            "route": "GET /apps/{app}/objects/{object}/{item}/{audit}",
            "request": { "method": "GET", "path": format!("/apps/App1/objects/Order/{item_path}/audit-1") },
            "calls": [{
                "service": "DynamoDB",
                "command": "GetItem",
                "input": { "TableName": "TEST-Contract-Audit-v2", "Key": { "PK": { "S": "-#App1#Order#audit-1" }, "SK": { "S": "audit" } } },
                "output": { "Item": item },
            }],
        })
    };

    let found = replay("numeric", &fixture("42"), contract_router).await;
    assert_eq!(found.answer["statusCode"], 200, "{:?}", found.answer);
    assert_eq!(found.answer["body"]["target"]["id"], 42);
    assert_eq!(found.failures, Vec::<String>::new());

    let other = replay("numeric-other", &fixture("43"), contract_router).await;
    assert_eq!(other.answer["statusCode"], 404);
    assert_eq!(other.failures, Vec::<String>::new());
}
