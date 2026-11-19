//! The `POST /apps/{app}/objects/{object}/{item}/{audit}/rerun` Lambda
//! (`rerun/handler.ts`): sends a rerunable audit's recorded EventBridge event
//! again. An audit is rerunable when it recorded an event and wasn't stored with
//! `rerunable: false`; the SDK doesn't set the flag, so an unset one counts as
//! rerunable, as it does for an audit's related-resource copies.
//!
//! The event goes to the bus it recorded (`eventBusName`), which must be one of
//! the [`RerunBuses`], or to the audit event bus when it recorded none.
//!
//! In order: a 422 for an invalid path, a 404 when the audit is missing or
//! belongs to another item, a 400 when it isn't rerunable or its bus isn't
//! allowed, then one `PutEvents`, answered with a 204, or a logged 500 when the
//! event wasn't sent.

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
    /// Sends events again; an event without a bus goes to its bus.
    pub events: AuditEventBus,
    /// The buses an event that recorded one may be sent to.
    pub buses: RerunBuses,
}

/// The buses a rerun may send an event to, by ARN (`RERUN_EVENT_BUSES`). The
/// account and region resolve a bus recorded by name, as `PutEvents` does: to the
/// Lambda's own.
#[derive(Debug, Clone, Default)]
pub struct RerunBuses {
    account: String,
    region: String,
    arns: Vec<String>,
}

impl RerunBuses {
    /// The buses `arns`, resolving names in `account` and `region`.
    pub fn new(
        account: impl Into<String>,
        region: impl Into<String>,
        arns: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        RerunBuses {
            account: account.into(),
            region: region.into(),
            arns: arns.into_iter().map(Into::into).collect(),
        }
    }

    /// The comma-separated ARNs in `RERUN_EVENT_BUSES`, resolving names in
    /// `AWS_ACCOUNT` and `AWS_REGION`. None are allowed when it's unset.
    pub fn from_env() -> Self {
        let var = |name| std::env::var(name).unwrap_or_default();
        RerunBuses::new(
            var("AWS_ACCOUNT"),
            var("AWS_REGION"),
            var("RERUN_EVENT_BUSES")
                .split(',')
                .map(str::trim)
                .filter(|arn| !arn.is_empty()),
        )
    }

    /// The ARN of the allowed bus `bus` names, by ARN or by name.
    pub fn resolve(&self, bus: &str) -> Option<&str> {
        self.arns
            .iter()
            .find(|arn| {
                if bus.starts_with("arn:") {
                    return *arn == bus;
                }
                // arn:{partition}:events:{region}:{account}:event-bus/{name}
                let parts: Vec<&str> = arn.splitn(6, ':').collect();
                matches!(
                    parts.as_slice(),
                    [_, _, _, region, account, resource]
                        if *region == self.region
                            && *account == self.account
                            && resource.strip_prefix("event-bus/") == Some(bus)
                )
            })
            .map(String::as_str)
    }
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
    let bus = match event.event_bus_name.as_deref() {
        None => state.events.bus_name(),
        Some(recorded) => state.buses.resolve(recorded).ok_or_else(|| {
            HttpError::bad_request(format!("Event bus {recorded} is not allowed for reruns"))
        })?,
    };

    match state.events.resend(bus, event).await {
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
