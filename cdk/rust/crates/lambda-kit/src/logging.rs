//! Structured JSON logging through `tracing`, shaped like Powertools Logger output.
//!
//! Each event is one JSON line: `level`, `message`, `timestamp` and `service` first,
//! then the fields of the spans it's in (outermost first, so the Lambda runtime's
//! `requestId` and `xrayTraceId` appear on every line), then the event's own fields.
//!
//! ```no_run
//! lambda_kit::logging::init();
//! tracing::error!(error = %"Boom", attempts = 3, "Unable to rerun the event");
//! // {"level":"ERROR","message":"Unable to rerun the event","timestamp":"…",
//! //  "service":"audit","requestId":"…","error":"Boom","attempts":3}
//! ```
//!
//! The level comes from `AWS_LAMBDA_LOG_LEVEL` (Lambda's log level control), then
//! `POWERTOOLS_LOG_LEVEL`, then `LOG_LEVEL`, defaulting to `info`. It applies to
//! events only: spans at `info` and above are always kept, so a `warn` line still
//! carries the invocation's `requestId`. The service comes from
//! `POWERTOOLS_SERVICE_NAME`, as with Powertools.
//!
//! Log errors with [`ErrorChain`], so the cause behind a wrapper ("unhandled
//! error", "dispatch failure") is in the line too.

use std::error::Error;
use std::fmt;

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::filter::{FilterExt, filter_fn};
use tracing_subscriber::fmt::format::{JsonFields, Writer};
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, FormattedFields, MakeWriter};
use tracing_subscriber::layer::{Filter, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer, Registry};

use crate::clock::to_iso_string;

const LEVEL_VARIABLES: [&str; 3] = ["AWS_LAMBDA_LOG_LEVEL", "POWERTOOLS_LOG_LEVEL", "LOG_LEVEL"];

/// Installs the JSON logger as the global `tracing` subscriber, writing to stdout.
///
/// Does nothing if a global subscriber is already set, so it's safe to call twice.
pub fn init() {
    let service = std::env::var("POWERTOOLS_SERVICE_NAME").ok();

    let _ = Registry::default()
        .with(layer(service, std::io::stdout).with_filter(filter(level_filter())))
        .try_init();
}

/// Lets through the events `level` allows, and every span at `info` and above,
/// so the fields of the spans an event is in (such as the runtime's `requestId`)
/// are recorded whatever the level.
pub fn filter<S>(level: EnvFilter) -> impl Filter<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    level.or(filter_fn(|metadata: &Metadata<'_>| {
        metadata.is_span() && *metadata.level() <= Level::INFO
    }))
}

/// The level filter `init` uses, from the environment.
pub fn level_filter() -> EnvFilter {
    let level = LEVEL_VARIABLES
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "info".to_owned());

    // Lambda's levels include FATAL, which tracing doesn't have
    let level = match level.to_ascii_lowercase().as_str() {
        "fatal" | "critical" => "error".to_owned(),
        other => other.to_owned(),
    };

    EnvFilter::try_new(level).unwrap_or_else(|_| EnvFilter::new("info"))
}

/// A formatting layer writing JSON lines to `writer`, for composing your own
/// subscriber (or capturing logs in tests).
pub fn layer<S, W>(service: Option<String>, writer: W) -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    tracing_subscriber::fmt::layer()
        .fmt_fields(JsonFields::new())
        .event_format(JsonFormat { service })
        .with_writer(writer)
}

/// Displays an error with its causes, `outer: cause: root cause`, skipping a cause
/// whose text the line already holds.
///
/// ```
/// use lambda_kit::logging::ErrorChain;
///
/// let error = std::io::Error::other("disk full");
/// tracing::error!(error = %ErrorChain(&error), "Unable to store the audit");
/// ```
pub struct ErrorChain<'a>(pub &'a (dyn Error + 'static));

impl fmt::Display for ErrorChain<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut text = self.0.to_string();
        let mut source = self.0.source();
        while let Some(cause) = source {
            let message = cause.to_string();
            if !text.contains(&message) {
                text.push_str(": ");
                text.push_str(&message);
            }
            source = cause.source();
        }
        f.write_str(&text)
    }
}

/// Formats each event as a JSON line, level and message first.
#[derive(Debug, Clone, Default)]
pub struct JsonFormat {
    /// The `service` key on every line, when set.
    pub service: Option<String>,
}

impl<S, N> FormatEvent<S, N> for JsonFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut fields = FieldVisitor::default();
        event.record(&mut fields);
        let mut fields = fields.0;

        let mut line = Map::new();
        line.insert(
            "level".into(),
            Value::String(event.metadata().level().as_str().into()),
        );
        line.insert(
            "message".into(),
            fields
                .shift_remove("message")
                .unwrap_or_else(|| Value::String(String::new())),
        );
        line.insert(
            "timestamp".into(),
            Value::String(to_iso_string(chrono::Utc::now())),
        );
        if let Some(service) = &self.service {
            line.insert("service".into(), Value::String(service.clone()));
        }

        if let Some(scope) = ctx.event_scope() {
            for span in scope.from_root() {
                let extensions = span.extensions();
                let Some(formatted) = extensions.get::<FormattedFields<N>>() else {
                    continue;
                };
                // Span fields were recorded with JsonFields, so they're a JSON object
                if let Ok(Value::Object(span_fields)) = serde_json::from_str(&formatted.fields) {
                    line.extend(span_fields);
                }
            }
        }

        line.extend(fields);

        writeln!(writer, "{}", Value::Object(line))
    }
}

/// Collects an event's fields as JSON values.
#[derive(Default)]
struct FieldVisitor(Map<String, Value>);

impl Visit for FieldVisitor {
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().into(), Value::from(value));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.0
            .insert(field.name().into(), Value::String(value.to_string()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.0
            .insert(field.name().into(), Value::String(format!("{value:?}")));
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;
    use crate::testing::LogCapture;

    fn capture(service: Option<&str>, emit: impl FnOnce()) -> Vec<Map<String, Value>> {
        let logs = LogCapture::with_service(service);
        emit();
        logs.lines()
    }

    #[test]
    fn writes_level_and_message_first() {
        let lines = capture(Some("audit"), || {
            tracing::info!(count = 2, ok = true, "Listed audits");
        });

        let keys: Vec<_> = lines[0].keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["level", "message", "timestamp", "service", "count", "ok"]
        );
        assert_eq!(lines[0]["level"], "INFO");
        assert_eq!(lines[0]["message"], "Listed audits");
        assert_eq!(lines[0]["service"], "audit");
        assert_eq!(lines[0]["count"], 2);
        assert_eq!(lines[0]["ok"], true);
    }

    #[test]
    fn includes_span_fields_outermost_first() {
        let lines = capture(None, || {
            let invoke = tracing::info_span!("invoke", requestId = "request-1");
            let _invoke = invoke.enter();
            let batch = tracing::info_span!("batch", size = 3);
            let _batch = batch.enter();

            tracing::warn!(error = %"Throttled", "Retrying");
        });

        let keys: Vec<_> = lines[0].keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "level",
                "message",
                "timestamp",
                "requestId",
                "size",
                "error"
            ]
        );
        assert_eq!(lines[0]["level"], "WARN");
        assert_eq!(lines[0]["requestId"], "request-1");
        assert_eq!(lines[0]["error"], "Throttled");
    }

    #[test]
    fn keeps_span_fields_on_lines_above_the_level() {
        let buffer = crate::testing::Buffer::default();
        let subscriber = Registry::default()
            .with(layer(None, buffer.clone()).with_filter(filter(EnvFilter::new("warn"))));

        tracing::subscriber::with_default(subscriber, || {
            let invoke = tracing::info_span!("invoke", requestId = "request-1");
            let _invoke = invoke.enter();
            let detail = tracing::debug_span!("detail", noisy = true);
            let _detail = detail.enter();

            tracing::info!("Hidden");
            tracing::warn!("Shown");
        });

        let lines = buffer.lines();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["message"], "Shown");
        assert_eq!(lines[0]["requestId"], "request-1");
        assert!(!lines[0].contains_key("noisy"));
    }

    #[derive(Debug)]
    struct Wrapper(io::Error);

    impl fmt::Display for Wrapper {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("unhandled error")
        }
    }

    impl Error for Wrapper {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn displays_errors_with_their_causes() {
        let error = Wrapper(io::Error::other("Connection refused"));
        assert_eq!(
            ErrorChain(&error).to_string(),
            "unhandled error: Connection refused"
        );

        // A cause the outer text already holds isn't repeated
        let error = io::Error::other(Wrapper(io::Error::other("Connection refused")));
        assert_eq!(
            ErrorChain(&error).to_string(),
            "unhandled error: Connection refused"
        );
    }

    #[test]
    fn records_errors_by_their_display_text() {
        let error = io::Error::other("disk full");

        let lines = capture(None, || {
            tracing::error!(
                error = &error as &(dyn std::error::Error + 'static),
                "Failed"
            );
        });

        assert_eq!(lines[0]["level"], "ERROR");
        assert_eq!(lines[0]["error"], "disk full");
    }
}
