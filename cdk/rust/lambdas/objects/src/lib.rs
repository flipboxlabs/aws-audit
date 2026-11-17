//! The `/apps/{app}/objects/{object}` Lambda:
//!
//! - `GET /apps/{app}/objects/{object}`: summaries of a resource type's audits,
//!   newest first
//! - `GET /apps/{app}/objects/{object}/{item}`: summaries of one resource's
//!   audits, newest first
//! - `GET /apps/{app}/objects/{object}/{item}/{audit}`: one whole audit
//!
//! Both listings include audits that name the resource as a related resource, and
//! take `filter[operation]` and `filter[tier]`.

use std::sync::Arc;

use aws_audit::AuditConfig;
use aws_audit::service::AuditService;
use aws_audit_http::{ObjectPath, audit_of_item, service_error};
use lambda_kit::http::{self, HttpRequest, Issues, Router};

/// What the handlers read with.
pub struct State {
    /// The apps and resource types paths may name.
    pub config: Arc<AuditConfig>,
    /// The audits.
    pub service: AuditService,
}

/// The Lambda's routes.
pub fn router(state: State) -> Router<State> {
    Router::new(state)
        .get("/apps/{app}/objects/{object}", list_objects)
        .get("/apps/{app}/objects/{object}/{item}", list_items)
        .get("/apps/{app}/objects/{object}/{item}/{audit}", detail)
}

async fn list_objects(state: Arc<State>, request: HttpRequest) -> http::Result {
    let mut issues = Issues::default();
    let path = ObjectPath::from_request(&state.config, &request, &mut issues);
    let pagination = aws_audit_http::pagination(&request, &mut issues);
    let filter = aws_audit_http::list_filter(&request, &mut issues);
    issues.finish()?;
    let path = path.expect("a valid path");

    let page = state
        .service
        .list_objects(None, &path.app, &path.resource_type, &filter, &pagination)
        .await
        .map_err(service_error)?;

    Ok(http::json(200, &page))
}

async fn list_items(state: Arc<State>, request: HttpRequest) -> http::Result {
    let mut issues = Issues::default();
    let path = ObjectPath::from_request(&state.config, &request, &mut issues);
    let pagination = aws_audit_http::pagination(&request, &mut issues);
    let filter = aws_audit_http::list_filter(&request, &mut issues);
    issues.finish()?;
    let path = path.expect("a valid path");

    let page = state
        .service
        .list_items(
            None,
            &path.app,
            &path.resource_type,
            request.param("item"),
            &filter,
            &pagination,
        )
        .await
        .map_err(service_error)?;

    Ok(http::json(200, &page))
}

async fn detail(state: Arc<State>, request: HttpRequest) -> http::Result {
    let mut issues = Issues::default();
    let path = ObjectPath::from_request(&state.config, &request, &mut issues);
    issues.finish()?;
    let path = path.expect("a valid path");

    let audit = audit_of_item(
        &state.service,
        &path.audit(request.param("audit")),
        request.param("item"),
    )
    .await?;

    Ok(http::json(200, &audit))
}
