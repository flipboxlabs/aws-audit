//! The `GET /status/{status}` Lambda: summaries of the audits with a status, newest
//! first. `filter[app]` and `filter[resourceType]` keep audits whose target or a
//! related resource matches; `filter[operation]` and `filter[tier]` narrow further.

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
    Router::new(state).get("/status/{status}", list)
}

async fn list(state: Arc<State>, request: HttpRequest) -> http::Result {
    let config = &state.config;

    let mut issues = Issues::default();
    let status = issues.check(
        ["path", "status"],
        aws_audit_http::status(request.param("status")),
    );
    let pagination = aws_audit_http::pagination(&request, &mut issues);
    let filter = aws_audit_http::list_filter(&request, &mut issues);
    let resources = aws_audit_http::resource_filter(config, &request, &mut issues);
    issues.finish()?;
    let status = status.expect("a valid status");

    let page = state
        .service
        .list_by_status(None, status, &filter, &resources, &pagination)
        .await
        .map_err(service_error)?;

    Ok(http::json(200, &page))
}
