//! The `GET /status/{status}` Lambda (`status/handler.ts`): audits with a status,
//! most recent first, optionally only those of an app or resource type.

use std::sync::Arc;

use aws_audit::AuditConfig;
use aws_audit::service::AuditService;
use aws_audit::storage::TargetFilter;
use aws_audit_http::service_error;
use lambda_kit::http::{self, HttpRequest, Issues, Router};

/// The app filter query parameter.
pub const FILTER_APP: &str = "filter[app]";

/// The resource type filter query parameter.
pub const FILTER_RESOURCE_TYPE: &str = "filter[resourceType]";

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
    let filter = TargetFilter {
        app: request
            .query(FILTER_APP)
            .and_then(|app| issues.check(["query", FILTER_APP], aws_audit_http::app(config, app))),
        resource_type: request
            .query(FILTER_RESOURCE_TYPE)
            .and_then(|resource_type| {
                issues.check(
                    ["query", FILTER_RESOURCE_TYPE],
                    aws_audit_http::resource_type(config, resource_type),
                )
            }),
        resource_id: None,
    };
    issues.finish()?;
    let status = status.expect("a valid status");

    let page = state
        .service
        .list_by_status(None, status, &filter, &pagination)
        .await
        .map_err(service_error)?;

    Ok(http::json(200, &page))
}
