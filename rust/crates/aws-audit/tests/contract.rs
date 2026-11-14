//! Checks the core crate against the fixtures the TypeScript implementation records
//! in `contract/` (see `contract/README.md`).

use std::path::PathBuf;

use aws_audit::pagination::{self, InvalidNextToken};
use aws_audit::table::Index;
use aws_audit::{Audit, Page};
use serde_json::Value;

fn contract() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../contract")
}

fn fixture(path: &str) -> Value {
    let path = contract().join("fixtures").join(path);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("unable to read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn fixtures(dir: &str) -> Vec<(String, Value)> {
    let root = contract().join("fixtures").join(dir);
    let mut found = Vec::new();
    let mut pending = vec![root.clone()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|ext| ext == "json") {
                let name = path.strip_prefix(&root).unwrap().with_extension("");
                let value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                found.push((name.to_string_lossy().into_owned(), value));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
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
fn listing(operation: &str, params: &Value) -> (Index, String) {
    let tenant = params["tenantId"]
        .as_str()
        .map(|tenant| format!("{tenant}#"))
        .unwrap_or_default();

    match operation {
        "listObjects" => (
            Index::Lsi1N,
            format!(
                "{tenant}{}.{}",
                params["app"].as_str().unwrap(),
                params["resource"]["type"].as_str().unwrap()
            ),
        ),
        "listByStatus" => (
            Index::Gsi2Ss,
            format!("{tenant}{}", params["status"].as_str().unwrap()),
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
            matches!(
                case["operation"].as_str(),
                Some("listObjects" | "listByStatus")
            ) && case["args"][1]["nextToken"].is_string()
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
            let page: Page<Audit> = serde_json::from_value(body.clone())
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
