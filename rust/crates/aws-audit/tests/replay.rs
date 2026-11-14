//! Replays every SDK fixture in `contract/fixtures/sdk` through the real AWS SDK
//! clients: each request body must equal the fixture's `input` (DynamoDB and
//! EventBridge put the request JSON on the wire as is), each answer is the
//! fixture's `output` or `error`, and the operation must return the fixture's
//! `result` or `error`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aws_audit::config::AuditConfig;
use aws_audit::events::AuditEventBus;
use aws_audit::pagination::Pagination;
use aws_audit::service::{AuditService, ServiceError};
use aws_audit::storage::{AuditRepository, Identifiers, StorageError, TargetFilter};
use aws_audit::upsert::UpsertAudit;
use aws_smithy_http_client::test_util::infallible_client_fn;
use aws_smithy_types::body::SdkBody;
use chrono::{DateTime, Utc};
use lambda_kit::clock::FixedClock;
use lambda_kit::retry::FixedJitter;
use serde_json::{Value, json};

const NOW: &str = "2026-01-02T03:04:05.678Z";
const RESOURCE_NAME: &str = "TEST-Contract-Audit";

#[derive(Debug)]
struct Call {
    service: String,
    command: String,
    input: Value,
}

#[derive(Default)]
struct Recorder {
    replies: Mutex<VecDeque<Value>>,
    calls: Mutex<Vec<Call>>,
}

fn http_client(recorder: Arc<Recorder>) -> aws_smithy_runtime_api::client::http::SharedHttpClient {
    infallible_client_fn(move |request: http::Request<SdkBody>| {
        let target = request
            .headers()
            .get("x-amz-target")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let (prefix, command) = target.split_once('.').unwrap_or(("", &target));
        let (service, content_type) = match prefix {
            "AWSEvents" => ("EventBridge", "application/x-amz-json-1.1"),
            _ => ("DynamoDB", "application/x-amz-json-1.0"),
        };
        let input = serde_json::from_slice(request.body().bytes().unwrap_or(b"{}")).unwrap();
        recorder.calls.lock().unwrap().push(Call {
            service: service.to_owned(),
            command: command.to_owned(),
            input,
        });

        let reply = recorder
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("no reply left for {service} {command}"));
        let (status, body) = match reply.get("error") {
            Some(error) => (
                400,
                json!({ "__type": error["name"], "message": error["message"] }),
            ),
            None => (200, reply["output"].clone()),
        };

        http::Response::builder()
            .status(status)
            .header("content-type", content_type)
            .body(SdkBody::from(body.to_string()))
            .unwrap()
    })
}

fn services(recorder: &Arc<Recorder>) -> AuditService {
    use aws_sdk_dynamodb::config::retry::RetryConfig;
    use aws_sdk_dynamodb::config::{
        BehaviorVersion, Credentials, Region, StalledStreamProtectionConfig,
    };

    let http = http_client(recorder.clone());
    let credentials = Credentials::new("AKIDEXAMPLE", "secret", None, None, "contract");

    let dynamodb = aws_sdk_dynamodb::Client::from_conf(
        aws_sdk_dynamodb::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(credentials.clone())
            .http_client(http.clone())
            .retry_config(RetryConfig::disabled())
            .stalled_stream_protection(StalledStreamProtectionConfig::disabled())
            .build(),
    );
    let eventbridge = aws_sdk_eventbridge::Client::from_conf(
        aws_sdk_eventbridge::Config::builder()
            .behavior_version(aws_sdk_eventbridge::config::BehaviorVersion::latest())
            .region(aws_sdk_eventbridge::config::Region::new("us-east-1"))
            .credentials_provider(credentials)
            .http_client(http)
            .retry_config(aws_sdk_eventbridge::config::retry::RetryConfig::disabled())
            .stalled_stream_protection(
                aws_sdk_eventbridge::config::StalledStreamProtectionConfig::disabled(),
            )
            .build(),
    );

    let config: AuditConfig = serde_json::from_value(json!({
        "apps": ["App1", "TestApp"],
        "resourceTypes": ["Unknown", "User", "Order"],
    }))
    .unwrap();
    let clock = Arc::new(FixedClock(
        DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .with_timezone(&Utc),
    ));
    let jitter = Arc::new(FixedJitter(0.5));

    let storage = AuditRepository::new(dynamodb, RESOURCE_NAME, &config)
        .with_clock(clock.clone())
        .with_jitter(jitter.clone());
    let events = AuditEventBus::new(eventbridge, RESOURCE_NAME).with_jitter(jitter);

    AuditService::new(Arc::new(config), storage, Some(events)).with_clock(clock)
}

/// A key's value, unless it's missing or null.
fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| !value.is_null())
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn pagination(value: &Value) -> Pagination {
    Pagination {
        page_size: value.get("pageSize").and_then(|size| {
            size.as_u64()
                .or_else(|| size.as_str().and_then(|size| size.parse().ok()))
                .map(|size| size as u32)
        }),
        next_token: string(value, "nextToken"),
    }
}

fn filter(params: &Value) -> TargetFilter {
    TargetFilter {
        app: string(params, "app"),
        resource_type: params.get("resource").and_then(|r| string(r, "type")),
        resource_id: params.get("resource").and_then(|r| string(r, "id")),
    }
}

/// Runs the fixture's operation; `Ok` holds the result as JSON.
async fn run(
    service: &AuditService,
    operation: &str,
    args: &[Value],
) -> Result<Value, ServiceError> {
    let params = &args[0];
    let page = args.get(1).map(pagination).unwrap_or_default();
    let tenant = string(params, "tenantId");
    let tenant = tenant.as_deref();

    let value = match operation {
        "getItem" => json!(
            service
                .get_item(&Identifiers {
                    tenant_id: string(params, "tenantId"),
                    app: string(params, "app").unwrap(),
                    resource_type: string(params, "resourceType").unwrap(),
                    id: string(params, "id").unwrap(),
                })
                .await?
        ),
        "upsertItem" => {
            let audit: UpsertAudit = serde_json::from_value(params.clone()).unwrap();
            service.upsert_item(audit).await?;
            Value::Null
        }
        "listObjects" => json!(
            service
                .list_objects(
                    tenant,
                    &string(params, "app").unwrap(),
                    &string(&params["resource"], "type").unwrap(),
                    &page
                )
                .await?
        ),
        "listItems" => json!(
            service
                .list_items(
                    tenant,
                    &string(params, "app").unwrap(),
                    &string(&params["resource"], "type").unwrap(),
                    &string(&params["resource"], "id").unwrap(),
                    &page,
                )
                .await?
        ),
        "listTraceItems" => json!(
            service
                .list_trace_items(
                    tenant,
                    &string(params, "trace").unwrap(),
                    &filter(params),
                    &page
                )
                .await?
        ),
        "listByStatus" => json!(
            service
                .list_by_status(
                    tenant,
                    string(params, "status").unwrap().parse().unwrap(),
                    &filter(params),
                    &page
                )
                .await?
        ),
        other => panic!("unknown operation {other}"),
    };

    Ok(value)
}

/// The TypeScript error class a Rust error corresponds to.
fn error_name(error: &ServiceError) -> String {
    match error {
        ServiceError::NotFound(_) => "AuditNotFoundError".into(),
        ServiceError::Storage(StorageError::InvalidNextToken(_)) => "InvalidNextTokenError".into(),
        other => format!("{other:?}"),
    }
}

/// Request bodies, with the Upserted event's `Detail` parsed (it's compared as a
/// value; see contract/README.md).
fn comparable(service: &str, mut input: Value) -> Value {
    if service == "EventBridge"
        && let Some(entries) = input.get_mut("Entries").and_then(Value::as_array_mut)
    {
        for entry in entries {
            if entry["DetailType"] == "Upserted"
                && let Some(detail) = entry["Detail"].as_str()
            {
                entry["Detail"] = serde_json::from_str(detail).unwrap();
            }
        }
    }
    input
}

fn fixtures() -> Vec<(String, Value)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contract/fixtures/sdk");
    let mut found = Vec::new();
    let mut pending = vec![root.clone()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let fixture: Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                if fixture.get("operation").is_some() {
                    let name = path.strip_prefix(&root).unwrap().with_extension("");
                    found.push((name.to_string_lossy().into_owned(), fixture));
                }
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

#[tokio::test(start_paused = true)]
async fn replays_every_sdk_fixture() {
    let fixtures = fixtures();
    assert!(
        fixtures.len() >= 25,
        "only {} fixtures found",
        fixtures.len()
    );

    let mut failures = Vec::new();
    for (name, fixture) in fixtures {
        let recorder = Arc::new(Recorder::default());
        recorder
            .replies
            .lock()
            .unwrap()
            .extend(fixture["calls"].as_array().unwrap().iter().map(|call| {
                match present(call, "error") {
                    Some(error) => json!({ "error": error }),
                    None => json!({ "output": call["output"] }),
                }
            }));
        let service = services(&recorder);

        let outcome = run(
            &service,
            fixture["operation"].as_str().unwrap(),
            fixture["args"].as_array().unwrap(),
        )
        .await;

        let calls = recorder.calls.lock().unwrap();
        let expected = fixture["calls"].as_array().unwrap();
        if calls.len() != expected.len() {
            failures.push(format!(
                "{name}: {} calls, expected {}: {:?}",
                calls.len(),
                expected.len(),
                calls.iter().map(|call| &call.command).collect::<Vec<_>>()
            ));
            continue;
        }
        for (index, (call, expected)) in calls.iter().zip(expected).enumerate() {
            let actual = (call.service.as_str(), call.command.as_str());
            let wanted = (
                expected["service"].as_str().unwrap(),
                expected["command"].as_str().unwrap(),
            );
            if actual != wanted {
                failures.push(format!(
                    "{name}: call {index} is {actual:?}, expected {wanted:?}"
                ));
            } else if comparable(&call.service, call.input.clone())
                != comparable(&call.service, expected["input"].clone())
            {
                failures.push(format!(
                    "{name}: call {index} ({}) input differs\n  rust:       {}\n  typescript: {}",
                    call.command,
                    comparable(&call.service, call.input.clone()),
                    comparable(&call.service, expected["input"].clone())
                ));
            }
        }

        match (outcome, present(&fixture, "error")) {
            (Ok(result), None) => {
                if result != fixture["result"] {
                    failures.push(format!(
                        "{name}: result differs\n  rust:       {result}\n  typescript: {}",
                        fixture["result"]
                    ));
                }
            }
            (Err(error), Some(expected)) => {
                if error_name(&error) != expected["name"] {
                    failures.push(format!(
                        "{name}: error {}, expected {}",
                        error_name(&error),
                        expected["name"]
                    ));
                } else if expected["name"] == "AuditNotFoundError"
                    && error.to_string() != expected["message"]
                {
                    failures.push(format!(
                        "{name}: message {error}, expected {}",
                        expected["message"]
                    ));
                }
            }
            (Ok(result), Some(expected)) => failures.push(format!(
                "{name}: returned {result}, expected {}",
                expected["name"]
            )),
            (Err(error), None) => failures.push(format!("{name}: failed with {error:?}")),
        }
    }

    assert!(
        failures.is_empty(),
        "{} mismatches:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
