//! Replaying the contract fixtures in `contract/` through the real AWS SDK clients.
//!
//! Enabled by the `testing` feature, for the tests here and in the Lambdas. A
//! [`Recorder`] stands in for AWS: it records each request and answers with the
//! next reply. [`contract_service`] builds an [`AuditService`] on it, set up the way
//! the TypeScript tests record the fixtures (see `contract/README.md`).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aws_smithy_http_client::test_util::infallible_client_fn;
use aws_smithy_runtime_api::client::http::SharedHttpClient;
use aws_smithy_types::body::SdkBody;
use chrono::{DateTime, Utc};
use lambda_kit::clock::FixedClock;
use lambda_kit::retry::FixedJitter;
use serde_json::{Value, json};

use crate::config::AuditConfig;
use crate::events::AuditEventBus;
use crate::service::AuditService;
use crate::storage::AuditRepository;

/// The clock every fixture is recorded at.
pub const NOW: &str = "2026-01-02T03:04:05.678Z";

/// The table name the fixtures use (`ENVIRONMENT=test`,
/// `SERVICE=Contract`).
pub const TABLE_NAME: &str = "TEST-Contract-Audit-v2";

/// The event bus name the fixtures use.
pub const EVENT_BUS_NAME: &str = "TEST-Contract-Audit";

/// The `contract/` directory at the repository root.
pub fn contract_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../contract")
}

/// Every JSON fixture under `contract/fixtures/{dir}`, named by its path there
/// without the extension, in name order.
pub fn fixtures(dir: &str) -> Vec<(String, Value)> {
    let root = contract_dir().join("fixtures").join(dir);
    let mut found = Vec::new();
    let mut pending = vec![root.clone()];
    while let Some(dir) = pending.pop() {
        let entries = std::fs::read_dir(&dir)
            .unwrap_or_else(|error| panic!("unable to read {}: {error}", dir.display()));
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let name = path.strip_prefix(&root).unwrap().with_extension("");
                let value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
                    .unwrap_or_else(|error| panic!("invalid {}: {error}", path.display()));
                found.push((name.to_string_lossy().into_owned(), value));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// A request a client sent.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    /// `DynamoDB` or `EventBridge`.
    pub service: String,
    /// The API action, e.g. `UpdateItem`.
    pub command: String,
    /// The request body.
    pub input: Value,
}

type Responder = Box<dyn Fn(&Call) -> Value + Send + Sync>;

/// Stands in for AWS: records each request and answers it.
///
/// A reply is `{"output": {...}}`, or `{"error": {"name", "message"}}` for a 400
/// with that error type.
pub struct Recorder {
    replies: Mutex<VecDeque<Value>>,
    responder: Option<Responder>,
    calls: Mutex<Vec<Call>>,
}

impl Recorder {
    /// Answers with a fixture's calls' outputs and errors, in order.
    pub fn replaying(calls: &[Value]) -> Arc<Self> {
        let replies = calls
            .iter()
            .map(
                |call| match call.get("error").filter(|error| !error.is_null()) {
                    Some(error) => json!({ "error": error }),
                    None => json!({ "output": call["output"] }),
                },
            )
            .collect();

        Arc::new(Recorder {
            replies: Mutex::new(replies),
            responder: None,
            calls: Mutex::default(),
        })
    }

    /// Answers each request with what `respond` returns for it.
    pub fn answering(respond: impl Fn(&Call) -> Value + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Recorder {
            replies: Mutex::default(),
            responder: Some(Box::new(respond)),
            calls: Mutex::default(),
        })
    }

    /// The requests so far, in the order they were sent.
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn reply(&self, call: &Call) -> Value {
        if let Some(respond) = &self.responder {
            return respond(call);
        }
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("no reply left for {} {}", call.service, call.command))
    }

    /// An HTTP client for the SDK clients that sends every request here.
    pub fn http_client(self: &Arc<Self>) -> SharedHttpClient {
        let recorder = self.clone();
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
            let call = Call {
                service: service.to_owned(),
                command: command.to_owned(),
                input: serde_json::from_slice(request.body().bytes().unwrap_or(b"{}")).unwrap(),
            };

            let reply = recorder.reply(&call);
            recorder.calls.lock().unwrap().push(call);
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
}

/// The config the fixtures are recorded with.
pub fn contract_config() -> AuditConfig {
    serde_json::from_value(json!({
        "apps": { "App1": ["Unknown", "User", "Order"], "TestApp": ["User", "Order"] },
    }))
    .unwrap()
}

/// SDK clients on `recorder`, in us-east-1 with fixed credentials, and without
/// retries.
fn contract_clients(
    recorder: &Arc<Recorder>,
) -> (aws_sdk_dynamodb::Client, aws_sdk_eventbridge::Client) {
    use aws_sdk_dynamodb::config::retry::RetryConfig;
    use aws_sdk_dynamodb::config::{
        BehaviorVersion, Credentials, Region, StalledStreamProtectionConfig,
    };

    let http = recorder.http_client();
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
    (dynamodb, eventbridge)
}

/// The retry jitter the fixtures are recorded with (`Math.random()` is 0.5).
fn contract_jitter() -> Arc<FixedJitter> {
    Arc::new(FixedJitter(0.5))
}

/// The fixtures' event bus on `recorder`.
pub fn contract_event_bus(recorder: &Arc<Recorder>) -> AuditEventBus {
    let (_, eventbridge) = contract_clients(recorder);
    AuditEventBus::new(eventbridge, EVENT_BUS_NAME).with_jitter(contract_jitter())
}

/// An audit service on `recorder`, with the fixtures' config, clock and jitter,
/// and no SDK retries.
pub fn contract_service(recorder: &Arc<Recorder>) -> AuditService {
    let (dynamodb, _) = contract_clients(recorder);

    let config = contract_config();
    let clock = Arc::new(FixedClock(
        DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .with_timezone(&Utc),
    ));

    let storage = AuditRepository::new(dynamodb, TABLE_NAME, &config)
        .with_clock(clock.clone())
        .with_jitter(contract_jitter());

    AuditService::new(
        Arc::new(config),
        storage,
        Some(contract_event_bus(recorder)),
    )
    .with_clock(clock)
}

/// A request body as compared: the `Upserted` event's `Detail` is parsed, since
/// it's compared as a value (see `contract/README.md`).
pub fn comparable(service: &str, mut input: Value) -> Value {
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

/// How `calls` differ from a fixture's `expected` calls, one message per
/// difference, each starting with `name`.
pub fn compare_calls(name: &str, calls: &[Call], expected: &[Value]) -> Vec<String> {
    if calls.len() != expected.len() {
        return vec![format!(
            "{name}: {} calls, expected {}: {:?}",
            calls.len(),
            expected.len(),
            calls.iter().map(|call| &call.command).collect::<Vec<_>>()
        )];
    }

    let mut failures = Vec::new();
    for (index, (call, expected)) in calls.iter().zip(expected).enumerate() {
        let actual = (call.service.as_str(), call.command.as_str());
        let wanted = (
            expected["service"].as_str().unwrap(),
            expected["command"].as_str().unwrap(),
        );
        let input = comparable(&call.service, call.input.clone());
        let expected_input = comparable(&call.service, expected["input"].clone());
        if actual != wanted {
            failures.push(format!(
                "{name}: call {index} is {actual:?}, expected {wanted:?}"
            ));
        } else if input != expected_input {
            failures.push(format!(
                "{name}: call {index} ({}) input differs\n  rust:       {input}\n  typescript: {expected_input}",
                call.command
            ));
        }
    }
    failures
}
