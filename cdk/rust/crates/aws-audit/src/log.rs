//! Recording audits from an app's Lambda (`Audits` in the TypeScript SDK).
//!
//! An app logs each audit to stdout as one JSON line, `{"_audit": {...}}`. The
//! audit stack's CloudWatch Logs subscription picks the lines up and stores them,
//! so an app needs no AWS clients or permissions to record audits.
//!
//! [`Audits`] buffers audits for an invocation and writes them when it's
//! published or dropped, so create one per invocation:
//!
//! ```
//! use std::sync::Arc;
//! use aws_audit::{AuditConfig, ResourceReference, Status};
//! use aws_audit::log::{Audits, LogAudit};
//!
//! let config = Arc::new(AuditConfig::new(["Orders"], ["Order"]));
//!
//! let mut audits = Audits::new(config);
//! audits.add(
//!     LogAudit::new("createOrder", ResourceReference::new("Orders", "Order").with_id("123"))
//!         .with_status(Status::Success)
//!         .with_message("Order created"),
//! )?;
//! // Written when `audits` is dropped, or now:
//! audits.publish();
//! # Ok::<(), aws_audit::upsert::InvalidAudit>(())
//! ```

use std::fmt;
use std::io::Write;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::config::AuditConfig;
use crate::model::{Context, EventBridgeEvent, ResourceReference, Status, Tier};
use crate::trace::xray_trace_id_from_env;
use crate::upsert::{InvalidAudit, check_audit};

/// The key an audit is logged under (`AUDIT_LOG_IDENTIFIER`).
pub const AUDIT_LOG_IDENTIFIER: &str = "_audit";

/// How many audits are buffered before they're written (`MAX_AUDITS_SIZE`).
pub const MAX_AUDITS_SIZE: usize = 20;

/// Set to a truthy value (`1`, `y`, `yes`, `t`, `true`, `on`) to write no audits,
/// or a falsy one to write them even in dev mode.
pub const DISABLED_VARIABLE: &str = "POWERTOOLS_AUDITS_DISABLED";

/// Set to a truthy value for dev mode, where audits aren't written unless
/// [`DISABLED_VARIABLE`] says otherwise.
pub const DEV_VARIABLE: &str = "POWERTOOLS_DEV";

/// An audit as an app logs it (`LogAuditInput`).
///
/// Fields serialize in the TypeScript schema's order, so a line reads the same
/// whichever SDK wrote it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogAudit {
    /// The audit's id; generated when stored if absent. Retries logged with the same
    /// id are one audit with an attempt each.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The operation's name.
    pub operation: String,
    /// The tenant, for multi-tenant apps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    /// Who sees the audit; [`Tier::INFO`] by default.
    #[serde(default)]
    pub tier: Tier,
    /// The outcome; [`Status::Success`] by default.
    #[serde(default = "default_status")]
    pub status: Status,
    /// The resource the operation acted on.
    pub target: ResourceReference,
    /// The resource that started the operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ResourceReference>,
    /// Extra metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// Other resources the operation affected; each with an id lists the audit too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<Vec<ResourceReference>>,
    /// A human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The trace, `{id}:{stage}`; the invocation's X-Ray trace id when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
    /// The event that triggered the operation, so it can be re-sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<EventBridgeEvent>,
    /// What went wrong.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_status() -> Status {
    Status::Success
}

impl LogAudit {
    /// A successful, tier 2 audit of `operation` on `target`.
    pub fn new(operation: impl Into<String>, target: ResourceReference) -> Self {
        LogAudit {
            id: None,
            operation: operation.into(),
            tenant_id: None,
            tier: Tier::default(),
            status: Status::Success,
            target,
            source: None,
            context: None,
            resources: None,
            message: None,
            trace: None,
            event: None,
            error: None,
        }
    }

    /// Sets the id, correlating retries.
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    /// Sets the tenant.
    pub fn with_tenant_id(mut self, tenant_id: impl Into<String>) -> Self {
        self.tenant_id = Some(tenant_id.into());
        self
    }

    /// Sets the tier.
    pub fn with_tier(mut self, tier: Tier) -> Self {
        self.tier = tier;
        self
    }

    /// Sets the outcome.
    pub fn with_status(mut self, status: Status) -> Self {
        self.status = status;
        self
    }

    /// Sets the resource that started the operation.
    pub fn with_source(mut self, source: ResourceReference) -> Self {
        self.source = Some(source);
        self
    }

    /// Sets the metadata.
    pub fn with_context(mut self, context: Context) -> Self {
        self.context = Some(context);
        self
    }

    /// Adds a related resource.
    pub fn with_resource(mut self, resource: ResourceReference) -> Self {
        self.resources.get_or_insert_with(Vec::new).push(resource);
        self
    }

    /// Sets the description.
    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    /// Adds to the description, after a space (`buildAudit`'s message merge).
    pub fn append_message(&mut self, message: &str) {
        self.message = match self.message.take() {
            Some(existing) if !existing.is_empty() && !message.is_empty() => {
                Some(format!("{existing} {message}"))
            }
            Some(existing) if message.is_empty() => Some(existing),
            _ => Some(message.to_owned()),
        };
    }

    /// Sets the trace.
    pub fn with_trace(mut self, trace: impl Into<String>) -> Self {
        self.trace = Some(trace.into());
        self
    }

    /// Sets the triggering event.
    pub fn with_event(mut self, event: EventBridgeEvent) -> Self {
        self.event = Some(event);
        self
    }

    /// Sets what went wrong.
    pub fn with_error(mut self, error: impl fmt::Display) -> Self {
        self.error = Some(error.to_string());
        self
    }

    /// Checks the tenant id isn't [`NO_TENANT`](crate::model::NO_TENANT), and the
    /// target, source and related resources against the configured apps and
    /// resource types.
    pub fn validate(&self, config: &AuditConfig) -> Result<(), InvalidAudit> {
        check_audit(
            config,
            self.tenant_id.as_deref(),
            &self.target,
            self.source.as_ref(),
            self.resources.iter().flatten(),
        )
    }
}

/// Buffers an invocation's audits and writes them to stdout (`Audits`).
///
/// Audits are written when [`publish`](Audits::publish) is called, when
/// [`MAX_AUDITS_SIZE`] are waiting, and when the buffer is dropped, so an
/// invocation that returns early with `?` or panics still writes its audits.
///
/// An audit without a trace gets the invocation's X-Ray trace id, read from
/// `_X_AMZN_TRACE_ID` when it's written. In the runtime's concurrent mode, pass the
/// invocation context's `xray_trace_id` to [`with_trace_id`](Audits::with_trace_id)
/// instead.
pub struct Audits {
    config: Arc<AuditConfig>,
    stored: Vec<LogAudit>,
    disabled: bool,
    trace_id: Option<String>,
    out: Box<dyn Write + Send>,
}

impl fmt::Debug for Audits {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Audits")
            .field("stored", &self.stored.len())
            .field("disabled", &self.disabled)
            .field("trace_id", &self.trace_id)
            .finish_non_exhaustive()
    }
}

impl Audits {
    /// Audits checked against `config`, written to stdout unless disabled by
    /// [`DISABLED_VARIABLE`] or dev mode.
    pub fn new(config: Arc<AuditConfig>) -> Self {
        Audits {
            config,
            stored: Vec::new(),
            disabled: disabled_from_env(),
            trace_id: None,
            out: Box::new(std::io::stdout()),
        }
    }

    /// Writes to `out` instead of stdout, e.g. to capture audits in tests.
    pub fn with_writer(mut self, out: impl Write + Send + 'static) -> Self {
        self.out = Box::new(out);
        self
    }

    /// Uses `trace_id` for audits without a trace, instead of `_X_AMZN_TRACE_ID`.
    pub fn with_trace_id(mut self, trace_id: impl Into<String>) -> Self {
        self.trace_id = Some(trace_id.into());
        self
    }

    /// Writes nothing, or writes despite the environment.
    pub fn with_disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Whether audits are dropped instead of written.
    pub fn is_disabled(&self) -> bool {
        self.disabled
    }

    /// How many audits are waiting to be written.
    pub fn len(&self) -> usize {
        self.stored.len()
    }

    /// Whether no audits are waiting.
    pub fn is_empty(&self) -> bool {
        self.stored.is_empty()
    }

    /// Buffers an audit, after checking its resources against the config. A full
    /// buffer is written first.
    pub fn add(&mut self, audit: LogAudit) -> Result<(), InvalidAudit> {
        if self.stored.len() >= MAX_AUDITS_SIZE {
            self.publish();
        }

        audit.validate(&self.config)?;
        self.stored.push(audit);
        Ok(())
    }

    /// Writes every buffered audit, one `{"_audit": {...}}` line each, and empties
    /// the buffer. A disabled buffer is emptied without writing.
    pub fn publish(&mut self) {
        let stored = std::mem::take(&mut self.stored);
        if self.disabled || stored.is_empty() {
            return;
        }

        let trace_id = self.trace_id.clone().or_else(xray_trace_id_from_env);
        let mut lines = String::new();
        for mut audit in stored {
            // An empty trace is none, as in the TypeScript SDK
            if audit.trace.as_deref().is_none_or(str::is_empty) {
                audit.trace.clone_from(&trace_id);
            }
            lines.push_str(&line(&audit));
            lines.push('\n');
        }

        // An audit that can't be written can't be reported anywhere else either
        let _ = self.out.write_all(lines.as_bytes());
        let _ = self.out.flush();
    }
}

impl Drop for Audits {
    fn drop(&mut self) {
        self.publish();
    }
}

/// An audit's log line: `{"_audit": {...}}`.
pub fn line(audit: &LogAudit) -> String {
    #[derive(Serialize)]
    struct Line<'a> {
        #[serde(rename = "_audit")]
        audit: &'a LogAudit,
    }

    serde_json::to_string(&Line { audit }).expect("an audit serializes to JSON")
}

/// Whether audits are off: [`DISABLED_VARIABLE`] when it's set, otherwise dev mode.
fn disabled_from_env() -> bool {
    match std::env::var(DISABLED_VARIABLE) {
        Ok(value) => flag(&value).unwrap_or(false),
        Err(_) => std::env::var(DEV_VARIABLE)
            .ok()
            .and_then(|value| flag(&value))
            .unwrap_or(false),
    }
}

/// A boolean environment value, as Powertools reads one with extended parsing.
fn flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "y" | "yes" | "t" | "true" | "on" => Some(true),
        "0" | "n" | "no" | "f" | "false" | "off" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};

    use super::*;
    use crate::model::ResourceId;

    /// A writer the test can read back.
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

    impl Captured {
        fn lines(&self) -> Vec<Value> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
    }

    fn config() -> Arc<AuditConfig> {
        Arc::new(AuditConfig::new(["App1", "TestApp"], ["Order", "User"]))
    }

    fn audits() -> (Audits, Captured) {
        let out = Captured::default();
        let audits = Audits::new(config())
            .with_writer(out.clone())
            .with_disabled(false)
            .with_trace_id("1-5759e988-bd862e3fe1be46a994272793");
        (audits, out)
    }

    fn order() -> ResourceReference {
        ResourceReference::new("App1", "Order").with_id("order-1")
    }

    #[test]
    fn writes_each_audit_as_a_line_in_schema_order() {
        let (mut audits, out) = audits();

        audits
            .add(
                LogAudit::new("createOrder", order())
                    .with_status(Status::Fail)
                    .with_tier(Tier::PUBLIC)
                    .with_source(ResourceReference::new("TestApp", "User"))
                    .with_resource(ResourceReference::new("TestApp", "User").with_id(7))
                    .with_message("Boom")
                    .with_error("Boom"),
            )
            .unwrap();
        audits.publish();

        let text = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        assert_eq!(
            text,
            concat!(
                r#"{"_audit":{"operation":"createOrder","tier":3,"status":"fail","#,
                r#""target":{"app":"App1","id":"order-1","type":"Order"},"#,
                r#""source":{"app":"TestApp","type":"User"},"#,
                r#""resources":[{"app":"TestApp","id":7,"type":"User"}],"#,
                r#""message":"Boom","trace":"1-5759e988-bd862e3fe1be46a994272793","error":"Boom"}}"#,
                "\n"
            )
        );
        assert!(audits.is_empty());
    }

    #[test]
    fn keeps_an_audits_own_trace() {
        let (mut audits, out) = audits();

        audits
            .add(LogAudit::new("createOrder", order()).with_trace("batch-1:2"))
            .unwrap();
        audits.publish();

        assert_eq!(out.lines()[0]["_audit"]["trace"], "batch-1:2");
    }

    #[test]
    fn replaces_an_empty_trace() {
        let (mut audits, out) = audits();

        audits
            .add(LogAudit::new("createOrder", order()).with_trace(""))
            .unwrap();
        audits.publish();

        assert_eq!(
            out.lines()[0]["_audit"]["trace"],
            "1-5759e988-bd862e3fe1be46a994272793"
        );
    }

    #[test]
    fn refuses_unknown_apps_and_types_at_their_paths() {
        let (mut audits, _) = audits();

        let error = audits
            .add(
                LogAudit::new("createOrder", ResourceReference::new("Nope", "Order"))
                    .with_resource(ResourceReference::new("App1", "Nope")),
            )
            .unwrap_err();

        let paths: Vec<_> = error
            .issues
            .iter()
            .map(|issue| issue.path.clone())
            .collect();
        assert_eq!(
            paths,
            [
                vec![json!("target"), json!("app")],
                vec![json!("resources"), json!(0), json!("type")],
            ]
        );
        assert!(audits.is_empty());
    }

    #[test]
    fn writes_a_full_buffer_before_adding() {
        let (mut audits, out) = audits();

        for _ in 0..MAX_AUDITS_SIZE {
            audits.add(LogAudit::new("op", order())).unwrap();
        }
        assert!(out.lines().is_empty());

        audits.add(LogAudit::new("op", order())).unwrap();
        assert_eq!(out.lines().len(), MAX_AUDITS_SIZE);
        assert_eq!(audits.len(), 1);
    }

    #[test]
    fn writes_what_is_left_when_dropped() {
        let (mut audits, out) = audits();
        audits.add(LogAudit::new("op", order())).unwrap();

        drop(audits);

        assert_eq!(out.lines().len(), 1);
    }

    #[test]
    fn drops_audits_when_disabled() {
        let (audits, out) = audits();
        let mut audits = audits.with_disabled(true);
        audits.add(LogAudit::new("op", order())).unwrap();

        audits.publish();

        assert!(audits.is_empty());
        assert!(out.lines().is_empty());
    }

    #[test]
    fn reads_lines_the_subscription_stores() {
        let audit = LogAudit::new("createOrder", order()).with_id("audit-1");

        let stored: crate::upsert::UpsertAudit = serde_json::from_value(
            serde_json::from_str::<Value>(&line(&audit)).unwrap()["_audit"].clone(),
        )
        .unwrap();

        assert_eq!(stored.id.as_deref(), Some("audit-1"));
        assert_eq!(stored.target.id, Some(ResourceId::from("order-1")));
    }

    #[test]
    fn appends_messages_with_a_space() {
        let mut audit = LogAudit::new("op", order());
        audit.append_message("Processing");
        audit.append_message("");
        audit.append_message("failed");
        assert_eq!(audit.message.as_deref(), Some("Processing failed"));
    }

    #[test]
    fn parses_flags_as_powertools_does() {
        for value in ["1", "y", "YES", "t", "true", "On"] {
            assert_eq!(flag(value), Some(true), "{value}");
        }
        for value in ["0", "n", "No", "f", "false", "off"] {
            assert_eq!(flag(value), Some(false), "{value}");
        }
        assert_eq!(flag("maybe"), None);
    }
}
