//! The `GET /trace/{trace}` Lambda: summaries of a trace's audits, by stage, then
//! oldest first. `filter[app]` and `filter[resourceType]` keep audits whose target
//! or a related resource matches; `filter[operation]` and `filter[tier]` narrow
//! further.

use std::sync::Arc;

use aws_audit::AuditConfig;
use aws_audit::service::AuditService;
use aws_audit_http::service_error;
use lambda_kit::http::{self, HttpRequest, Issues, Router};

/// What the handler reads with.
pub struct State {
    /// The apps and resource types filters may name.
    pub config: Arc<AuditConfig>,
    /// The audits.
    pub service: AuditService,
}

/// The Lambda's routes.
pub fn router(state: State) -> Router<State> {
    Router::new(state).get("/trace/{trace}", list)
}

async fn list(state: Arc<State>, request: HttpRequest) -> http::Result {
    let config = &state.config;

    let mut issues = Issues::default();
    let pagination = aws_audit_http::pagination(&request, &mut issues);
    let filter = aws_audit_http::list_filter(&request, &mut issues);
    let resources = aws_audit_http::resource_filter(config, &request, &mut issues);
    issues.finish()?;

    let page = state
        .service
        .list_trace_items(
            None,
            request.param("trace"),
            &filter,
            &resources,
            &pagination,
        )
        .await
        .map_err(service_error)?;

    Ok(http::json(200, &page))
}
