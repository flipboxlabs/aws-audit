//! Checks the core crate against the fixtures the TypeScript implementation records
//! in `contract/` (see `contract/README.md`).

use aws_audit::pagination::{self, InvalidNextToken};
use aws_audit::table::Index;
use aws_audit::testing::{contract_dir, fixtures};
use aws_audit::{Audit, AuditConfig, AuditSummary, Page};
use serde_json::Value;

fn fixture(path: &str) -> Value {
    let path = contract_dir().join("fixtures").join(path);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("unable to read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap()
}

#[test]
fn loads_the_config_the_layer_writes() {
    let config =
        AuditConfig::from_file(&contract_dir().join("fixtures/layer/audit-config.json")).unwrap();

    assert_eq!(config, aws_audit::testing::contract_config());
    assert_eq!(config.apps.keys().collect::<Vec<_>>(), ["App1", "TestApp"]);
}

#[test]
fn encodes_and_decodes_tokens_like_the_sdk() {
    let tokens = fixture("sdk/pagination-tokens.json")["tokens"].clone();

    for case in tokens.as_array().unwrap() {
        let key = case["key"].as_object().unwrap();
        let token = case["token"].as_str().unwrap();

        assert_eq!(pagination::encode(key), token, "encoding {key:?}");
        assert_eq!(
            pagination::decode(Some(token), None)
                .unwrap()
                .map(Value::Object),
            Some(case["decoded"].clone()),
            "decoding {token}"
        );
    }
}

/// The listing's index and the partition its arguments query.
fn listing(operation: &str, params: &Value) -> (Index, Vec<(&'static str, String)>) {
    let text = |value: &Value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    let tenant = (
        "tenantKey",
        params["tenantId"].as_str().unwrap_or("-").to_owned(),
    );
    let app = ("app", text(&params["app"]));
    let resource_type = ("resourceType", text(&params["resource"]["type"]));

    match operation {
        "listObjects" => (Index::ByType, vec![tenant, app, resource_type]),
        "listItems" => (
            Index::ByResource,
            vec![
                tenant,
                app,
                resource_type,
                ("resourceId", text(&params["resource"]["id"])),
            ],
        ),
        "listByStatus" => (
            Index::ByStatus,
            vec![
                tenant,
                ("status", text(&params["status"])),
                ("kind", "audit".to_owned()),
            ],
        ),
        "listTraceItems" => (
            Index::ByTrace,
            vec![tenant, ("traceId", text(&params["trace"]))],
        ),
        other => panic!("no index mapping for {other}"),
    }
}

#[test]
fn refuses_the_tokens_the_sdk_refuses() {
    let refused: Vec<_> = fixtures("sdk")
        .into_iter()
        .filter(|(_, case)| case["error"]["name"] == "InvalidNextTokenError")
        .collect();
    assert_eq!(refused.len(), 4, "expected the four token-* fixtures");

    for (name, case) in refused {
        let (index, partition) = listing(case["operation"].as_str().unwrap(), &case["args"][0]);
        let token = case["args"][1]["nextToken"].as_str();

        assert_eq!(
            pagination::exclusive_start_key(token, index, &partition),
            Err(InvalidNextToken),
            "{name}"
        );
        assert_eq!(case["calls"], Value::Array(vec![]), "{name} queried");
    }
}

#[test]
fn accepts_the_tokens_the_sdk_sends() {
    let accepted: Vec<_> = fixtures("sdk")
        .into_iter()
        .filter(|(_, case)| {
            case["operation"]
                .as_str()
                .is_some_and(|operation| operation.starts_with("list"))
                && case["args"][1]["nextToken"].is_string()
                && case.get("error").is_none()
        })
        .collect();
    assert!(!accepted.is_empty());

    for (name, case) in accepted {
        let (index, partition) = listing(case["operation"].as_str().unwrap(), &case["args"][0]);
        let token = case["args"][1]["nextToken"].as_str();

        let key = pagination::exclusive_start_key(token, index, &partition)
            .unwrap_or_else(|error| panic!("{name}: {error}"))
            .unwrap();

        // The query resumes from the decoded key
        let sent = &case["calls"][0]["input"]["ExclusiveStartKey"];
        for (attribute, value) in &key {
            let typed = &sent[attribute];
            let text = typed["S"].as_str().or(typed["N"].as_str()).unwrap();
            assert_eq!(
                text,
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), str::to_owned),
                "{name} {attribute}"
            );
        }
    }
}

#[test]
fn round_trips_every_audit_the_api_returns() {
    let mut checked = 0;

    for (name, case) in fixtures("http") {
        let response = &case["response"];
        if response["statusCode"] != 200 {
            continue;
        }
        let body = response["body"].clone();

        let reserialized = if body.get("items").is_some() {
            let page: Page<AuditSummary> = serde_json::from_value(body.clone())
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            serde_json::to_value(page).unwrap()
        } else if body.get("operation").is_some() {
            let audit: Audit = serde_json::from_value(body.clone())
                .unwrap_or_else(|error| panic!("{name}: {error}"));
            serde_json::to_value(audit).unwrap()
        } else {
            continue;
        };

        assert_eq!(reserialized, body, "{name}");
        checked += 1;
    }

    assert!(checked >= 5, "only {checked} audit responses found");
}
