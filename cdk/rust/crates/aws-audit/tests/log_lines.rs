//! Replays `contract/fixtures/sdk/log-lines.json`: `Audits` logs what the
//! TypeScript `Audits` logs for the same input.

use std::io::Write;
use std::sync::{Arc, Mutex};

use aws_audit::log::{Audits, LogAudit};
use aws_audit::testing::{contract_config, contract_dir};
use aws_audit::trace::xray_trace_id;
use serde_json::Value;

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn audit_keys(line: &Value) -> Vec<&String> {
    line["_audit"].as_object().unwrap().keys().collect()
}

#[test]
fn logs_what_the_typescript_sdk_logs() {
    let path = contract_dir().join("fixtures/sdk/log-lines.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let trace_id = xray_trace_id(fixture["traceHeader"].as_str().unwrap()).unwrap();
    let config = Arc::new(contract_config());

    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let out = Captured::default();
        let mut audits = Audits::new(config.clone())
            .with_writer(out.clone())
            .with_disabled(false)
            .with_trace_id(trace_id);

        let audit: LogAudit = serde_json::from_value(case["input"].clone())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        audits.add(audit).unwrap();
        audits.publish();

        let written = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        let expected = case["line"].as_str().unwrap();
        assert!(
            written.ends_with('\n') && expected.ends_with('\n'),
            "{name}"
        );
        assert_eq!(written.lines().count(), 1, "{name}");

        // Compared as values: a resource reference's keys are ordered differently,
        // which the subscription doesn't see
        let actual: Value = serde_json::from_str(&written).unwrap();
        let expected: Value = serde_json::from_str(expected).unwrap();
        assert_eq!(actual, expected, "{name}");
        assert_eq!(audit_keys(&actual), audit_keys(&expected), "{name}");
    }
}
