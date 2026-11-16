//! Replays every SDK fixture in `contract/fixtures/sdk` through the real AWS SDK
//! clients: each request body must equal the fixture's `input` (DynamoDB and
//! EventBridge put the request JSON on the wire as is), each answer is the
//! fixture's `output` or `error`, and the operation must return the fixture's
//! `result` or `error`.

use aws_audit::pagination::Pagination;
use aws_audit::service::{AuditService, ServiceError};
use aws_audit::storage::{Identifiers, StorageError, TargetFilter};
use aws_audit::testing::{Recorder, compare_calls, contract_service, fixtures};
use aws_audit::upsert::UpsertAudit;
use serde_json::{Value, json};

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

#[tokio::test(start_paused = true)]
async fn replays_every_sdk_fixture() {
    // Pagination tokens have their own fixture, checked in contract.rs
    let fixtures: Vec<_> = fixtures("sdk")
        .into_iter()
        .filter(|(_, fixture)| fixture.get("operation").is_some())
        .collect();
    assert!(
        fixtures.len() >= 25,
        "only {} fixtures found",
        fixtures.len()
    );

    let mut failures = Vec::new();
    for (name, fixture) in fixtures {
        let recorder = Recorder::replaying(fixture["calls"].as_array().unwrap());
        let service = contract_service(&recorder);

        let outcome = run(
            &service,
            fixture["operation"].as_str().unwrap(),
            fixture["args"].as_array().unwrap(),
        )
        .await;

        let mismatches = compare_calls(
            &name,
            &recorder.calls(),
            fixture["calls"].as_array().unwrap(),
        );
        if !mismatches.is_empty() {
            failures.extend(mismatches);
            continue;
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
