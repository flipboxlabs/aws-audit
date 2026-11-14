//! Audit operations as the Lambdas use them (`AuditService` in the TypeScript SDK):
//! upserts with attempt tracking, related-resource copies and an `Upserted` event,
//! plus reads and listings.

use std::fmt;
use std::sync::Arc;

use lambda_kit::clock::{Clock, SystemClock};
use serde_json::Value;

use crate::config::AuditConfig;
use crate::events::{AuditEventBus, PutEventsError};
use crate::keys::has_resource_id;
use crate::model::{Attempt, Audit, ResourceId, Status, Timestamp};
use crate::pagination::{Page, Pagination};
use crate::storage::{AuditRepository, Identifiers, StorageError, TargetFilter};
use crate::upsert::{InvalidUpsert, UpsertAudit};

/// No audit has these identifiers.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct AuditNotFound(pub Identifiers);

impl fmt::Display for AuditNotFound {
    // "Unable to find Audit app:App1 | resourceType:Order | id:missing", as in TypeScript
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let identifiers = &self.0;
        let mut parts = Vec::with_capacity(4);
        if let Some(tenant) = &identifiers.tenant_id {
            parts.push(format!("tenantId:{tenant}"));
        }
        parts.push(format!("app:{}", identifiers.app));
        parts.push(format!("resourceType:{}", identifiers.resource_type));
        parts.push(format!("id:{}", identifiers.id));
        write!(f, "Unable to find Audit {}", parts.join(" | "))
    }
}

/// An audit operation failed.
#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    /// The audit doesn't exist.
    #[error(transparent)]
    NotFound(#[from] AuditNotFound),
    /// The upsert names an app or resource type the config doesn't list.
    #[error(transparent)]
    Invalid(#[from] InvalidUpsert),
    /// Reading or writing the table failed, or a `nextToken` was invalid.
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// Audit operations.
#[derive(Debug, Clone)]
pub struct AuditService {
    config: Arc<AuditConfig>,
    storage: AuditRepository,
    events: Option<AuditEventBus>,
    clock: Arc<dyn Clock>,
}

impl AuditService {
    /// A service storing in `storage` and, unless `events` is `None`, announcing
    /// upserts on `events`.
    pub fn new(
        config: Arc<AuditConfig>,
        storage: AuditRepository,
        events: Option<AuditEventBus>,
    ) -> Self {
        AuditService {
            config,
            storage,
            events,
            clock: Arc::new(SystemClock),
        }
    }

    /// Uses `clock` for attempt times. Give the repository the same clock.
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// The audit with these identifiers.
    pub async fn get_item(&self, identifiers: &Identifiers) -> Result<Audit, ServiceError> {
        self.storage
            .get_item(identifiers)
            .await?
            .ok_or_else(|| AuditNotFound(identifiers.clone()).into())
    }

    /// Stores an audit, or records another attempt of an existing one.
    ///
    /// The audit gets an attempt (numbered by its position in the stored list);
    /// each related resource with an id gets a copy, so it lists under that
    /// resource too; and an `Upserted` event is sent. The audit is stored even when
    /// the event can't be: that failure is logged, not returned.
    pub async fn upsert_item(&self, audit: UpsertAudit) -> Result<(), ServiceError> {
        audit.validate(&self.config)?;

        let mut audit = audit;
        let id = audit.id.clone().unwrap_or_else(crate::id::generate);
        audit.id = Some(id.clone());

        let attempt = Attempt {
            number: 1,
            status: audit.status,
            error: audit.error.clone().map(Value::String),
            at: Timestamp::from(self.clock.now()),
        };
        self.storage.upsert_item(&audit, &id, &attempt).await?;

        let copies: Vec<UpsertAudit> = audit
            .resources
            .iter()
            .flatten()
            .filter(|resource| has_resource_id(resource.id.as_ref()))
            .map(|resource| UpsertAudit {
                // Deterministic, so a retry rewrites the same copy
                id: Some(format!(
                    "{id}#{}.{}#{}",
                    resource.app,
                    resource.resource_type,
                    resource
                        .id
                        .as_ref()
                        .map(ResourceId::to_key)
                        .unwrap_or_default()
                )),
                target: resource.clone(),
                source: Some(audit.target.clone()),
                rerunable: Some(audit.rerunable.unwrap_or(audit.event.is_some())),
                // Only the parent keeps these
                event: None,
                error: None,
                attempts: None,
                ..audit.clone()
            })
            .collect();
        if !copies.is_empty() {
            self.storage.upsert_batch(&copies).await?;
        }

        if let Some(events) = &self.events
            && let Err(error) = events.upserted(std::slice::from_ref(&audit)).await
        {
            log_unpublished(&audit, &error);
        }

        Ok(())
    }

    /// Audits of a resource type.
    pub async fn list_objects(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, ServiceError> {
        logged(
            "list objects",
            self.storage
                .list_objects(tenant_id, app, resource_type, pagination)
                .await,
        )
    }

    /// Audits of one resource.
    pub async fn list_items(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        resource_id: &str,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, ServiceError> {
        logged(
            "list items",
            self.storage
                .list_items(tenant_id, app, resource_type, resource_id, pagination)
                .await,
        )
    }

    /// Audits of a trace.
    pub async fn list_trace_items(
        &self,
        tenant_id: Option<&str>,
        trace: &str,
        filter: &TargetFilter,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, ServiceError> {
        logged(
            "list trace items",
            self.storage
                .list_trace_items(tenant_id, trace, filter, pagination)
                .await,
        )
    }

    /// Audits with a status.
    pub async fn list_by_status(
        &self,
        tenant_id: Option<&str>,
        status: Status,
        filter: &TargetFilter,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, ServiceError> {
        logged(
            "list items by status",
            self.storage
                .list_by_status(tenant_id, status, filter, pagination)
                .await,
        )
    }
}

/// Logs a listing's storage failure. A bad `nextToken` is the caller's mistake, so
/// it isn't logged.
fn logged<T>(listing: &str, result: Result<T, StorageError>) -> Result<T, ServiceError> {
    if let Err(error) = &result
        && !matches!(error, StorageError::InvalidNextToken(_))
    {
        tracing::error!(error = %error, "An error occurred while trying to {listing}");
    }
    Ok(result?)
}

fn log_unpublished(audit: &UpsertAudit, error: &PutEventsError) {
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
        tenant_id = audit.tenant_id.as_deref(),
        id = audit.id.as_deref(),
        app = %audit.target.app,
        target_type = %audit.target.resource_type,
        target_id = audit.target.id.as_ref().map(ResourceId::to_key),
        failed_entries = ?failed,
        error = %error,
        "Audit stored but Upserted event not published"
    );
}
