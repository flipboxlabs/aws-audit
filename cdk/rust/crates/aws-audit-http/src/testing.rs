//! Replaying the REST fixtures in `contract/fixtures/http` through a Lambda's
//! router, for the tests in each REST Lambda.
//!
//! [`request`] builds the API Gateway REST (v1) proxy event the TypeScript tests
//! sent, and [`answer`] reads a response back in the fixtures' shape, so the two
//! compare as values (see `contract/README.md`).

use std::sync::Arc;

use aws_audit::testing::{Recorder, compare_calls, fixtures};
use lambda_http::http::header::CONTENT_TYPE;
use lambda_http::request::LambdaRequest;
use lambda_http::{Body, Request, Response};
use lambda_kit::http::Router;
use serde_json::{Map, Value, json};

/// A replayed fixture: the answer, in the fixtures' shape, and how the run
/// differed from the fixture.
#[derive(Debug)]
pub struct Replay {
    /// `{statusCode, contentType, body}`.
    pub answer: Value,
    /// One message per difference in the calls, the response, or the 200 body's
    /// schema; empty when it matches.
    pub failures: Vec<String>,
}

/// Runs a fixture through the router `router` builds on a [`Recorder`] that
/// replays the fixture's calls.
///
/// The calls must match the fixture's and the answer its `response`; a 200's body
/// must also follow its route's schema in `contract/schemas`.
pub async fn replay<S: Send + Sync + 'static>(
    name: &str,
    fixture: &Value,
    router: impl FnOnce(&Arc<Recorder>) -> Router<S>,
) -> Replay {
    let calls = fixture["calls"].as_array().map_or(&[][..], Vec::as_slice);
    let recorder = Recorder::replaying(calls);
    let answer = answer(&router(&recorder).handle(request(fixture)).await);

    let mut failures = compare_calls(name, &recorder.calls(), calls);
    if let Some(response) = fixture.get("response") {
        failures.extend(compare_response(name, &answer, response));
    }
    if answer["statusCode"] == 200
        && let Some(schema) = response_schema(fixture["route"].as_str().unwrap_or_default())
    {
        failures.extend(check_response_schema(name, schema, &answer["body"]));
    }

    Replay { answer, failures }
}

/// Replays every fixture in `contract/fixtures/{dir}` (see [`replay`]) and
/// panics with every difference.
pub async fn replay_fixtures<S: Send + Sync + 'static>(
    dir: &str,
    router: impl Fn(&Arc<Recorder>) -> Router<S>,
) {
    let fixtures = fixtures(dir);
    assert!(!fixtures.is_empty(), "no fixtures in {dir}");

    let mut failures = Vec::new();
    for (name, fixture) in &fixtures {
        failures.extend(replay(name, fixture, &router).await.failures);
    }

    assert!(
        failures.is_empty(),
        "{} mismatches in {} fixtures:\n\n{}",
        failures.len(),
        fixtures.len(),
        failures.join("\n\n")
    );
}

/// The `contract/schemas` response schema a route's 200s follow.
fn response_schema(route: &str) -> Option<&'static str> {
    match route {
        "GET /config" => Some("config"),
        "GET /status/{status}" => Some("status"),
        "GET /trace/{trace}" => Some("trace"),
        "GET /apps/{app}/objects/{object}" => Some("objects"),
        "GET /apps/{app}/objects/{object}/{item}" => Some("items"),
        "GET /apps/{app}/objects/{object}/{item}/{audit}" => Some("detail"),
        _ => None,
    }
}

/// The request a fixture describes, as API Gateway delivers it for the fixture's
/// `route` (e.g. `GET /status/{status}`).
pub fn request(fixture: &Value) -> Request {
    let route = fixture["route"].as_str().expect("a fixture route");
    let (_, resource) = route.split_once(' ').expect("a route is METHOD /resource");
    let method = fixture["request"]["method"]
        .as_str()
        .expect("a request method");
    let path = fixture["request"]["path"].as_str().expect("a request path");

    // A parameter's value is its segment of the path, decoded as API Gateway does
    let segments: Vec<&str> = path.split('/').collect();
    let mut params = Map::new();
    for (index, segment) in resource.split('/').enumerate() {
        if let Some(name) = segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            let value = percent_decode(segments.get(index).copied().unwrap_or_default());
            params.insert(name.to_owned(), json!(value));
        }
    }

    let query = fixture["request"]["query"].as_object();
    let event = json!({
        "resource": resource,
        "path": path,
        "httpMethod": method,
        "headers": { "accept": "application/json" },
        "multiValueHeaders": { "accept": ["application/json"] },
        "pathParameters": if params.is_empty() { Value::Null } else { Value::Object(params) },
        "queryStringParameters": query,
        "multiValueQueryStringParameters": query.map(|query| query
            .iter()
            .map(|(key, value)| (key.clone(), json!([value])))
            .collect::<Map<_, _>>()),
        "stageVariables": null,
        "body": null,
        "isBase64Encoded": false,
        "requestContext": {
            "accountId": "123456789012",
            "apiId": "contract",
            "httpMethod": method,
            "path": format!("/test{path}"),
            "protocol": "HTTP/1.1",
            "requestId": "request-id",
            "resourceId": "resource",
            "resourcePath": resource,
            "stage": "test",
            "identity": { "sourceIp": "127.0.0.1", "userAgent": "contract" },
        },
    });

    serde_json::from_value::<LambdaRequest>(event)
        .expect("a REST proxy event")
        .into()
}

fn percent_decode(segment: &str) -> String {
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .expect("a UTF-8 path")
        .into_owned()
}

/// A response in the fixtures' shape: `{statusCode, contentType, body}`, with the
/// body parsed, or `null` when there is none.
pub fn answer(response: &Response<Body>) -> Value {
    let body = match response.body() {
        Body::Empty => Value::Null,
        Body::Text(text) => serde_json::from_str(text).expect("a JSON body"),
        _ => panic!("a binary body"),
    };
    let body = match body {
        Value::String(text) if text.is_empty() => Value::Null,
        body => body,
    };

    json!({
        "statusCode": response.status().as_u16(),
        "contentType": response
            .headers()
            .get(CONTENT_TYPE)
            .map(|value| value.to_str().expect("a text content type")),
        "body": body,
    })
}

/// How `answer` differs from a fixture's `response`, one message per
/// difference, each starting with `name`.
pub fn compare_response(name: &str, answer: &Value, expected: &Value) -> Vec<String> {
    ["statusCode", "contentType", "body"]
        .into_iter()
        .filter(|key| answer[key] != expected[key])
        .map(|key| {
            format!(
                "{name}: {key} differs\n  rust:       {}\n  typescript: {}",
                answer[key], expected[key]
            )
        })
        .collect()
}

/// How a 200's body fails `contract/schemas/{schema}.response.schema.json`, one
/// message per error, each starting with `name`.
pub fn check_response_schema(name: &str, schema: &str, body: &Value) -> Vec<String> {
    let path = aws_audit::testing::contract_dir()
        .join("schemas")
        .join(format!("{schema}.response.schema.json"));
    let schema: Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("unable to read {}: {error}", path.display())),
    )
    .expect("a JSON schema");
    let validator = jsonschema::validator_for(&schema).expect("a valid JSON schema");

    validator
        .iter_errors(body)
        .map(|error| format!("{name}: {} at {}", error, error.instance_path()))
        .collect()
}
