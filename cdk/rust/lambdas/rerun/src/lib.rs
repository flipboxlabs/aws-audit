//! The `POST /apps/{app}/objects/{object}/{item}/{audit}/rerun` Lambda
//! (`rerun/handler.ts`): sends a rerunable audit's recorded EventBridge event
//! again. An audit is rerunable when it recorded an event and wasn't stored with
//! `rerunable: false`; the SDK doesn't set the flag, so an unset one counts as
//! rerunable, as it does for an audit's related-resource copies.
//!
//! In order: a 422 for an invalid path, a 404 when the audit is missing or
//! belongs to another item, a 400 when it isn't rerunable, then one `PutEvents`,
//! answered with a 204, or a logged 500 when the event wasn't sent.

use std::sync::Arc;

use aws_audit::AuditConfig;
use aws_audit::events::{AuditEventBus, PutEventsError};
use aws_audit::service::AuditService;
use aws_audit_http::{ObjectPath, audit_of_item};
use lambda_kit::http::{self, HttpError, HttpRequest, Issues, Router, StatusCode};
use lambda_kit::logging::ErrorChain;

/// What the handler reads and sends with.
pub struct State {
    /// The apps and resource types paths may name.
    pub config: Arc<AuditConfig>,
    /// The audits.
    pub service: AuditService,
    /// Where events are sent again.
    pub events: AuditEventBus,
}

/// The Lambda's routes.
pub fn router(state: State) -> Router<State> {
    Router::new(state).post("/apps/{app}/objects/{object}/{item}/{audit}/rerun", rerun)
}

async fn rerun(state: Arc<State>, request: HttpRequest) -> http::Result {
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

    let Some(event) = audit
        .event
        .as_ref()
        .filter(|_| audit.rerunable != Some(false))
    else {
        return Err(HttpError::bad_request("Item is not rerunable").into());
    };

    match state.events.resend(event).await {
        Ok(_) => Ok(http::no_content()),
        Err(error) => {
            log_unsent(&error);
            Err(HttpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalServerError",
                "Unable to rerun the event",
            )
            .into())
        }
    }
}

fn log_unsent(error: &PutEventsError) {
    let failed: Vec<String> = error
        .failed_entries
        .iter()
        .map(|entry| {
            format!(
                "{}: {}",
                entry.error_code().unwrap_or_default(),
                entry.error_message().unwrap_or_default()
            )
        })
        .collect();
    tracing::error!(
        failedEntries = ?failed,
        error = %ErrorChain(error),
        "Unable to rerun the event"
    );
}
