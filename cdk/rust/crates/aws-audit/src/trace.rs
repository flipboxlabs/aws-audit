//! Traces: `{id}:{stage}`, where the stage counts the hops an operation took
//! (`getTraceParts` and `incrementTraceStage` in the TypeScript SDK), and the X-Ray
//! trace an audit defaults to.

/// The environment variable the Lambda runtime sets to the invocation's X-Ray trace
/// header: `Root=1-5759e988-bd862e3fe1be46a994272793;Parent=…;Sampled=1`.
pub const XRAY_TRACE_VARIABLE: &str = "_X_AMZN_TRACE_ID";

/// A trace's id and stage: `batch:2026:3` is `("batch:2026", 3)`. The stage is the
/// integer after the last colon; without one, the whole trace is the id at stage 0.
pub fn trace_parts(trace: &str) -> (&str, u64) {
    match trace.rsplit_once(':') {
        Some((id, stage)) if !stage.is_empty() && stage.bytes().all(|b| b.is_ascii_digit()) => {
            match stage.parse() {
                Ok(stage) => (id, stage),
                Err(_) => (trace, 0),
            }
        }
        _ => (trace, 0),
    }
}

/// The trace one hop further: `abc:2` is `abc:3`. A trace without a stage counts as
/// stage 1, so `abc` is `abc:2`.
pub fn increment_trace_stage(trace: &str) -> String {
    match trace_parts(trace) {
        (id, stage) if id.len() < trace.len() => format!("{id}:{}", stage.saturating_add(1)),
        _ => format!("{trace}:2"),
    }
}

/// The X-Ray trace id in a trace header: its `Root`, or the whole header when it
/// has no fields.
pub fn xray_trace_id(header: &str) -> Option<&str> {
    if header.is_empty() {
        return None;
    }
    if !header.contains('=') {
        return Some(header);
    }
    header
        .split(';')
        .find_map(|field| field.strip_prefix("Root="))
        .filter(|root| !root.is_empty())
}

/// The invocation's X-Ray trace id, from [`XRAY_TRACE_VARIABLE`].
///
/// The runtime sets it for each invocation, except in concurrent mode
/// (`AWS_LAMBDA_MAX_CONCURRENCY`), where it's the invocation context's
/// `xray_trace_id` instead.
pub fn xray_trace_id_from_env() -> Option<String> {
    let header = std::env::var(XRAY_TRACE_VARIABLE).ok()?;
    xray_trace_id(&header).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_traces_on_the_last_colon() {
        assert_eq!(trace_parts("abc-123:5"), ("abc-123", 5));
        assert_eq!(trace_parts("abc-123"), ("abc-123", 0));
        assert_eq!(trace_parts("batch:2026:3"), ("batch:2026", 3));
        for trace in ["batch:a", "batch:", "batch:-1", "batch:1.5", "batch:5x"] {
            assert_eq!(trace_parts(trace), (trace, 0), "{trace}");
        }
    }

    #[test]
    fn increments_the_stage() {
        assert_eq!(increment_trace_stage("abc:2"), "abc:3");
        assert_eq!(increment_trace_stage("abc:0"), "abc:1");
        assert_eq!(increment_trace_stage("batch:2026:3"), "batch:2026:4");
        assert_eq!(increment_trace_stage("abc"), "abc:2");
        assert_eq!(increment_trace_stage("batch:a"), "batch:a:2");
    }

    #[test]
    fn reads_the_root_of_a_trace_header() {
        assert_eq!(
            xray_trace_id(
                "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=557abcec3ee5a047;Sampled=1"
            ),
            Some("1-5759e988-bd862e3fe1be46a994272793")
        );
        assert_eq!(xray_trace_id("1-5759e988"), Some("1-5759e988"));
        assert_eq!(xray_trace_id("Parent=557abcec3ee5a047"), None);
        assert_eq!(xray_trace_id(""), None);
    }
}
