//! Audit operations as the Lambdas use them (`AuditService` in the TypeScript SDK):
//! upserts with attempt tracking, related-resource copies and an `Upserted` event,
//! plus reads and listings.

use std::fmt;
use std::sync::Arc;

use lambda_kit::clock::{Clock, SystemClock};
use lambda_kit::logging::ErrorChain;
use serde_json::Value;

use crate::config::AuditConfig;
use crate::events::{AuditEventBus, PutEventsError};
use crate::model::{Attempt, Audit, AuditSummary, ResourceId, Status, Timestamp};
use crate::pagination::{Page, Pagination};
use crate::storage::{AuditRepository, Identifiers, ListFilter, ResourceFilter, StorageError};
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
    /// each related resource with an id gets a copy, created with the audit, so it
    /// lists under that resource too; and an `Upserted` event is sent. The audit is stored even when
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
        let upserted = self.storage.upsert_item(&audit, &id, &attempt).await?;
        self.storage
            .upsert_related(&audit, &id, &upserted.created_at)
            .await?;

        if let Some(events) = &self.events
            && let Err(error) = events.upserted(std::slice::from_ref(&audit)).await
        {
            log_unpublished(&audit, &error);
        }

        Ok(())
    }

    /// Summaries of a resource type's audits.
    pub async fn list_objects(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        filter: &ListFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, ServiceError> {
        logged(
            "list objects",
            self.storage
                .list_objects(tenant_id, app, resource_type, filter, pagination)
                .await,
        )
    }

    /// Summaries of one resource's audits.
    pub async fn list_items(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        resource_id: &str,
        filter: &ListFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, ServiceError> {
        logged(
            "list items",
            self.storage
                .list_items(
                    tenant_id,
                    app,
                    resource_type,
                    resource_id,
                    filter,
                    pagination,
                )
                .await,
        )
    }

    /// Summaries of a trace's audits.
    pub async fn list_trace_items(
        &self,
        tenant_id: Option<&str>,
        trace: &str,
        filter: &ListFilter,
        resources: &ResourceFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, ServiceError> {
        logged(
            "list trace items",
            self.storage
                .list_trace_items(tenant_id, trace, filter, resources, pagination)
                .await,
        )
    }

    /// Summaries of a status's audits.
    pub async fn list_by_status(
        &self,
        tenant_id: Option<&str>,
        status: Status,
        filter: &ListFilter,
        resources: &ResourceFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, ServiceError> {
        logged(
            "list items by status",
            self.storage
                .list_by_status(tenant_id, status, filter, resources, pagination)
                .await,
        )
    }
}

/// Logs a listing's storage failure. A bad `nextToken` or filter is the caller's
/// mistake, so it isn't logged.
fn logged<T>(listing: &str, result: Result<T, StorageError>) -> Result<T, ServiceError> {
    if let Err(error) = &result
        && !matches!(
            error,
            StorageError::InvalidNextToken(_) | StorageError::IncompleteResourceFilter(_)
        )
    {
        tracing::error!(error = %ErrorChain(error), "An error occurred while trying to {listing}");
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
        tenantId = audit.tenant_id.as_deref(),
        id = audit.id.as_deref(),
        app = %audit.target.app,
        targetType = %audit.target.resource_type,
        targetId = audit.target.id.as_ref().map(ResourceId::to_key),
        failedEntries = ?failed,
        error = %ErrorChain(error),
        "Audit stored but Upserted event not published"
    );
}
