//! The audit table: reads, upserts and listings (`AuditRepository` in the
//! TypeScript SDK). Requests match the TypeScript SDK's, recorded in
//! `contract/fixtures/sdk`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::types::{AttributeValue, PutRequest, ReturnValue, WriteRequest};
use lambda_kit::clock::{Clock, SystemClock};
use lambda_kit::logging::ErrorChain;
use lambda_kit::retry::{Backoff, Jitter, RandomJitter};
use serde_json::{Map, Value};

use crate::attribute::{Item, marshall_map, unmarshall, unmarshall_map};
use crate::config::AuditConfig;
use crate::keys::{
    IncompleteResourceFilter, ReservedTenant, audit_scopes, filter_scope, has_resource_id,
    index_attributes, primary_key, related_sort_key, tenant_key,
};
use crate::model::{Attempt, Audit, AuditSummary, ResourceReference, Status, Tier, Timestamp};
use crate::pagination::{self, InvalidNextToken, Page, PageInfo, Pagination};
use crate::table::{Index, SUMMARY_PROJECTION, attributes, keys, kinds};
use crate::upsert::{StoredAudit, UpsertAudit};

/// Items per `BatchWriteItem` request (DynamoDB's limit).
const WRITE_BATCH_SIZE: usize = 25;

/// Retries of a batch's unprocessed part before giving up.
const BATCH_RETRIES: u32 = 8;

/// A storage failure.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    /// DynamoDB refused or failed the request. Boxed, as SDK errors are large.
    #[error(transparent)]
    DynamoDb(Box<aws_sdk_dynamodb::Error>),
    /// A request couldn't be built.
    #[error("unable to build the request: {0}")]
    Build(#[from] aws_sdk_dynamodb::error::BuildError),
    /// A stored item isn't a valid audit.
    #[error("stored audit is invalid: {0}")]
    InvalidItem(#[from] serde_json::Error),
    /// The listing's `nextToken` isn't one it issued.
    #[error(transparent)]
    InvalidNextToken(#[from] InvalidNextToken),
    /// A listing's resource filter names an id without its app and type.
    #[error(transparent)]
    IncompleteResourceFilter(#[from] IncompleteResourceFilter),
    /// A listing names the tenant id reserved for audits without a tenant.
    #[error(transparent)]
    ReservedTenant(#[from] ReservedTenant),
    /// A batch still had unprocessed items after every retry.
    #[error("{operation} failed: unprocessed {noun} after {retries} retries")]
    Unprocessed {
        /// `BatchWriteItem`.
        operation: &'static str,
        /// What was left: `items`.
        noun: &'static str,
        /// The retries made.
        retries: u32,
    },
    /// `UpdateItem` returned no attributes.
    #[error("UpdateItem did not return attributes")]
    MissingAttributes,
}

impl<E, R> From<aws_sdk_dynamodb::error::SdkError<E, R>> for StorageError
where
    aws_sdk_dynamodb::Error: From<aws_sdk_dynamodb::error::SdkError<E, R>>,
{
    fn from(error: aws_sdk_dynamodb::error::SdkError<E, R>) -> Self {
        StorageError::DynamoDb(Box::new(error.into()))
    }
}

impl From<aws_sdk_dynamodb::Error> for StorageError {
    fn from(error: aws_sdk_dynamodb::Error) -> Self {
        StorageError::DynamoDb(Box::new(error))
    }
}

/// An audit's table key, as the REST API addresses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identifiers {
    /// The tenant.
    pub tenant_id: Option<String>,
    /// The target's app.
    pub app: String,
    /// The target's resource type.
    pub resource_type: String,
    /// The audit id.
    pub id: String,
}

/// Filters every listing takes, applied as a filter expression after a page is
/// read: a filtered page can hold fewer items than its size, or none, while a
/// `nextToken` continues the listing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListFilter {
    /// Only audits of this operation (exact match).
    pub operation: Option<String>,
    /// Only audits of this tier.
    pub tier: Option<Tier>,
}

/// Filters on an audit's resources, for the status and trace listings. They match
/// the audit's target or any of its related resources.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResourceFilter {
    /// The resource's app.
    pub app: Option<String>,
    /// The resource's type.
    pub resource_type: Option<String>,
    /// The resource's id; matched only together with its app and type.
    pub resource_id: Option<String>,
}

impl ResourceFilter {
    /// The `scopes` value the filter matches, if it filters at all.
    pub fn scope(&self) -> Result<Option<String>, IncompleteResourceFilter> {
        filter_scope(
            self.app.as_deref(),
            self.resource_type.as_deref(),
            self.resource_id.as_deref(),
        )
    }
}

/// What an upsert stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Upserted {
    /// The attempt's number: its position in the audit's attempts.
    pub attempt_number: u32,
    /// The audit as stored (`ALL_NEW`): the fields a retry kept as well as those it
    /// gave, and the stored `createdAt`, which a retry keeps.
    pub audit: Audit,
}

/// Reads and writes audits.
#[derive(Debug, Clone)]
pub struct AuditRepository {
    client: Client,
    table: String,
    ttl_seconds: u64,
    clock: Arc<dyn Clock>,
    jitter: Arc<dyn Jitter>,
    backoff: Backoff,
}

impl AuditRepository {
    /// A repository for `table`, with the config's TTL.
    pub fn new(client: Client, table: impl Into<String>, config: &AuditConfig) -> Self {
        AuditRepository {
            client,
            table: table.into(),
            ttl_seconds: config.ttl_seconds,
            clock: Arc::new(SystemClock),
            jitter: Arc::new(RandomJitter),
            backoff: Backoff {
                attempts: BATCH_RETRIES + 1,
                base: Duration::from_millis(100),
                max_delay: Duration::from_secs(30),
            },
        }
    }

    /// Uses `clock` for timestamps and TTLs.
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// Uses `jitter` for retry delays.
    pub fn with_jitter(mut self, jitter: Arc<dyn Jitter>) -> Self {
        self.jitter = jitter;
        self
    }

    /// The audit with these identifiers, if it exists.
    pub async fn get_item(&self, identifiers: &Identifiers) -> Result<Option<Audit>, StorageError> {
        let key = primary_key(
            identifiers.tenant_id.as_deref(),
            &identifiers.app,
            &identifiers.resource_type,
            &identifiers.id,
        )?;

        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(marshall_map(&key)))
            .send()
            .await
            .map_err(|error| {
                let error = StorageError::from(error);
                tracing::error!(
                    tenantId = identifiers.tenant_id.as_deref(),
                    app = %identifiers.app,
                    resourceType = %identifiers.resource_type,
                    id = %identifiers.id,
                    error = %ErrorChain(&error),
                    "Failed to read audit item"
                );
                error
            })?;

        output
            .item()
            .map(|item| parse_item(unmarshall_map(item)))
            .transpose()
    }

    /// Creates or updates the audit `id`, appending `attempt` to its attempts.
    ///
    /// A retry replaces the fields it gives and keeps those it leaves out, except
    /// the target, which it replaces whole: a target without an id removes
    /// `resourceId`, so the audit no longer lists under its earlier resource.
    ///
    /// Returns the attempt's number (its position in the stored list, which differs
    /// from `attempt.number` on a retry) and the audit as stored, with the stored
    /// `createdAt`, which a retry keeps, so the audit keeps its place in every
    /// listing.
    pub async fn upsert_item(
        &self,
        audit: &UpsertAudit,
        id: &str,
        attempt: &Attempt,
    ) -> Result<Upserted, StorageError> {
        let now = self.clock.now();
        let stored = StoredAudit::new(audit, id.to_owned(), &Timestamp::from(now));
        let key = primary_key(
            stored.tenant_id.as_deref(),
            &stored.target.app,
            &stored.target.resource_type,
            &stored.id,
        )?;

        let mut names = HashMap::from([
            ("#attempts".to_owned(), "attempts".to_owned()),
            ("#createdAt".to_owned(), "createdAt".to_owned()),
        ]);
        let mut values = Map::from_iter([
            (":emptyList".to_owned(), Value::Array(vec![])),
            (
                ":newAttempt".to_owned(),
                Value::Array(vec![serde_json::to_value(attempt)?]),
            ),
        ]);
        let mut clauses = vec![
            "#attempts = list_append(if_not_exists(#attempts, :emptyList), :newAttempt)".to_owned(),
            "#createdAt = if_not_exists(#createdAt, :createdAt)".to_owned(),
        ];

        let Value::Object(payload) = serde_json::to_value(&stored)? else {
            unreachable!("an audit serializes to an object");
        };
        let scopes = audit_scopes(&stored.target, audit.resources.iter().flatten());
        let fields = payload
            .into_iter()
            .chain(index_attributes(
                stored.tenant_id.as_deref(),
                &stored.target,
                stored.trace.as_deref(),
                kinds::AUDIT,
            )?)
            .chain([(attributes::TTL.to_owned(), Value::from(self.ttl(now)))]);
        for (name, value) in fields {
            // The list_append clause owns attempts; createdAt's clause is above
            if name == "attempts" || value.is_null() {
                continue;
            }
            names.insert(format!("#{name}"), name.clone());
            if name != "createdAt" {
                clauses.push(format!("#{name} = :{name}"));
            }
            values.insert(format!(":{name}"), value);
        }

        // Added to, not replaced: a copy under a resource a retry no longer lists
        // stays, so the status and trace filters keep matching that resource too
        names.insert("#scopes".to_owned(), attributes::SCOPES.to_owned());
        let mut values = marshall_map(&values);
        values.insert(":scopes".to_owned(), AttributeValue::Ss(scopes));

        // The target is replaced whole, so its resourceId goes with it
        let mut remove = "";
        if !has_resource_id(stored.target.id.as_ref()) {
            names.insert("#resourceId".to_owned(), attributes::RESOURCE_ID.to_owned());
            remove = " REMOVE #resourceId";
        }

        let output = self
            .client
            .update_item()
            .table_name(&self.table)
            .set_key(Some(marshall_map(&key)))
            .update_expression(format!(
                "SET {} ADD #scopes :scopes{remove}",
                clauses.join(", ")
            ))
            .set_expression_attribute_names(Some(names))
            .set_expression_attribute_values(Some(values))
            .return_values(ReturnValue::AllNew)
            .send()
            .await?;

        let attributes = output.attributes().ok_or(StorageError::MissingAttributes)?;
        let attempts = attributes
            .get("attempts")
            .and_then(|attempts| attempts.as_l().ok())
            .ok_or(StorageError::MissingAttributes)?;
        let number = u32::try_from(attempts.len()).unwrap_or(u32::MAX);
        let mut audit = parse_item(unmarshall_map(attributes))?;

        // A retry appended to earlier attempts: renumber this one by its position
        if number != attempt.number {
            self.client
                .update_item()
                .table_name(&self.table)
                .set_key(Some(marshall_map(&key)))
                .update_expression(format!(
                    "SET #attempts[{}].#number = :attemptNumber",
                    number - 1
                ))
                .expression_attribute_names("#attempts", "attempts")
                .expression_attribute_names("#number", "number")
                .set_expression_attribute_values(Some(marshall_map(&Map::from_iter([(
                    ":attemptNumber".to_owned(),
                    Value::from(number),
                )]))))
                .send()
                .await?;
        }

        // As renumbered above
        if let Some(appended) = audit
            .attempts
            .as_mut()
            .and_then(|attempts| attempts.last_mut())
        {
            appended.number = number;
        }

        Ok(Upserted {
            attempt_number: number,
            audit,
        })
    }

    /// Writes the copy of `audit` that lists it under each of the `related`
    /// resources with an id, 25 per `BatchWriteItem`, retrying unprocessed items.
    ///
    /// A copy holds the audit's summary, with the resource as `target` and the
    /// audit's target as `source`, in the audit's partition (`SK`
    /// `related#{app}#{type}#{resourceId}`), marked `related`. It is built from the
    /// audit as stored (from [`upsert_item`](Self::upsert_item)), so it holds the
    /// fields a retry kept and sorts with the audit by its stored `createdAt`. Each
    /// upsert rewrites the copies of the resources it lists, once per resource,
    /// except its own target, under which the audit lists already; a copy under a
    /// resource a retry no longer lists stays, as do that resource's `scopes` on
    /// the audit.
    pub async fn upsert_related<'a>(
        &self,
        audit: &Audit,
        related: impl IntoIterator<Item = &'a ResourceReference>,
    ) -> Result<(), StorageError> {
        // One copy per resource: a BatchWriteItem can't put the same key twice. The
        // last listing of a resource wins, as it would have if each were written in turn
        let own =
            has_resource_id(audit.target.id.as_ref()).then(|| related_sort_key(&audit.target));
        let mut resources: Vec<(String, &ResourceReference)> = Vec::new();
        for resource in related
            .into_iter()
            .filter(|resource| has_resource_id(resource.id.as_ref()))
        {
            let sort_key = related_sort_key(resource);
            // The audit lists under its own target already
            if own.as_ref() == Some(&sort_key) {
                continue;
            }
            match resources.iter_mut().find(|(listed, _)| *listed == sort_key) {
                Some(listed) => listed.1 = resource,
                None => resources.push((sort_key, resource)),
            }
        }
        if resources.is_empty() {
            return Ok(());
        }

        let now = self.clock.now();
        let key = primary_key(
            audit.tenant_id.as_deref(),
            &audit.target.app,
            &audit.target.resource_type,
            &audit.id,
        )?;

        let Value::Object(payload) = serde_json::to_value(audit)? else {
            unreachable!("an audit serializes to an object");
        };
        let summary: Map<String, Value> = payload
            .into_iter()
            .filter(|(name, _)| SUMMARY_PROJECTION.contains(&name.as_str()))
            .collect();
        let source = serde_json::to_value(&audit.target)?;
        let rerunable = audit.rerunable.unwrap_or(audit.event.is_some());

        let mut requests = Vec::new();
        for (sort_key, resource) in resources {
            let mut item = Map::from_iter([
                (
                    keys::PARTITION_KEY.to_owned(),
                    key[keys::PARTITION_KEY].clone(),
                ),
                (keys::SORT_KEY.to_owned(), Value::String(sort_key)),
            ]);
            item.extend(summary.clone());
            item.insert("target".to_owned(), serde_json::to_value(resource)?);
            item.insert("source".to_owned(), source.clone());
            item.insert("rerunable".to_owned(), Value::Bool(rerunable));
            item.insert("related".to_owned(), Value::Bool(true));
            item.extend(index_attributes(
                audit.tenant_id.as_deref(),
                resource,
                None,
                kinds::RELATED,
            )?);
            item.insert(attributes::TTL.to_owned(), Value::from(self.ttl(now)));

            requests.push(
                WriteRequest::builder()
                    .put_request(
                        PutRequest::builder()
                            .set_item(Some(marshall_map(&item)))
                            .build()?,
                    )
                    .build(),
            );
        }

        // Sequentially, so a throttled table isn't hit harder
        for chunk in requests.chunks(WRITE_BATCH_SIZE) {
            self.write_batch(chunk.to_vec()).await?;
        }

        Ok(())
    }

    /// The TTL of an item written at `now`: epoch seconds.
    fn ttl(&self, now: chrono::DateTime<chrono::Utc>) -> i64 {
        now.timestamp_millis()
            .div_euclid(1000)
            .saturating_add_unsigned(self.ttl_seconds)
    }

    async fn write_batch(&self, requests: Vec<WriteRequest>) -> Result<(), StorageError> {
        let mut pending = HashMap::from([(self.table.clone(), requests)]);
        let mut attempt = 0;

        loop {
            let output = self
                .client
                .batch_write_item()
                .set_request_items(Some(pending))
                .send()
                .await?;

            let Some(unprocessed) = output.unprocessed_items.filter(|items| !items.is_empty())
            else {
                return Ok(());
            };
            let count: usize = unprocessed.values().map(Vec::len).sum();

            attempt += 1;
            if attempt > BATCH_RETRIES {
                tracing::error!(
                    count,
                    attempt,
                    "BatchWriteItem: unprocessed items remain after max retries"
                );
                return Err(StorageError::Unprocessed {
                    operation: "BatchWriteItem",
                    noun: "items",
                    retries: BATCH_RETRIES,
                });
            }

            let delay = self.backoff.delay(attempt, self.jitter.sample());
            tracing::warn!(
                count,
                attempt,
                delayMs = delay.as_millis() as u64,
                "BatchWriteItem: retrying unprocessed items"
            );
            tokio::time::sleep(delay).await;
            pending = unprocessed;
        }
    }

    /// Summaries of a resource type's audits, newest first. Audits that name a
    /// resource of this type as a related resource are listed too, with that
    /// resource as `target` and the audit's own target as `source`.
    pub async fn list_objects(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        filter: &ListFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, StorageError> {
        let partition = vec![
            (attributes::TENANT_KEY, tenant_key(tenant_id)?.to_owned()),
            (attributes::APP, app.to_owned()),
            (attributes::RESOURCE_TYPE, resource_type.to_owned()),
        ];

        self.list_index(Index::ByType, partition, false, filter, None, pagination)
            .await
    }

    /// Summaries of one resource's audits, newest first, including audits that name
    /// it as a related resource.
    pub async fn list_items(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        resource_id: &str,
        filter: &ListFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, StorageError> {
        let partition = vec![
            (attributes::TENANT_KEY, tenant_key(tenant_id)?.to_owned()),
            (attributes::APP, app.to_owned()),
            (attributes::RESOURCE_TYPE, resource_type.to_owned()),
            (attributes::RESOURCE_ID, resource_id.to_owned()),
        ];

        self.list_index(
            Index::ByResource,
            partition,
            false,
            filter,
            None,
            pagination,
        )
        .await
    }

    /// Summaries of a trace's audits, by stage, then oldest first. Resource filters
    /// match an audit's target or any of its related resources.
    pub async fn list_trace_items(
        &self,
        tenant_id: Option<&str>,
        trace: &str,
        filter: &ListFilter,
        resources: &ResourceFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, StorageError> {
        let partition = vec![
            (attributes::TENANT_KEY, tenant_key(tenant_id)?.to_owned()),
            (attributes::TRACE_ID, trace.to_owned()),
        ];

        self.list_index(
            Index::ByTrace,
            partition,
            true,
            filter,
            resources.scope()?,
            pagination,
        )
        .await
    }

    /// Summaries of a status's audits (not their related-resource copies), newest
    /// first. Resource filters match an audit's target or any of its related
    /// resources.
    pub async fn list_by_status(
        &self,
        tenant_id: Option<&str>,
        status: Status,
        filter: &ListFilter,
        resources: &ResourceFilter,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, StorageError> {
        let partition = vec![
            (attributes::TENANT_KEY, tenant_key(tenant_id)?.to_owned()),
            (attributes::STATUS, status.as_str().to_owned()),
            (attributes::KIND, kinds::AUDIT.to_owned()),
        ];

        self.list_index(
            Index::ByStatus,
            partition,
            false,
            filter,
            resources.scope()?,
            pagination,
        )
        .await
    }

    /// Reads a page of an index partition (each partition key attribute with its
    /// value) as audit summaries.
    async fn list_index(
        &self,
        index: Index,
        partition: Vec<(&'static str, String)>,
        forward: bool,
        filter: &ListFilter,
        scope: Option<String>,
        pagination: &Pagination,
    ) -> Result<Page<AuditSummary>, StorageError> {
        let start_key =
            pagination::exclusive_start_key(pagination.next_token.as_deref(), index, &partition)?;

        let mut names = HashMap::new();
        let mut values = Map::new();
        let mut conditions = Vec::with_capacity(partition.len());
        for (i, (name, value)) in partition.into_iter().enumerate() {
            names.insert(format!("#k{i}"), name.to_owned());
            values.insert(format!(":k{i}"), Value::String(value));
            conditions.push(format!("#k{i} = :k{i}"));
        }
        let filter_expression = filter_expression(filter, scope, &mut names, &mut values);

        let output = self
            .client
            .query()
            .table_name(&self.table)
            .index_name(index.name())
            .scan_index_forward(forward)
            .key_condition_expression(conditions.join(" AND "))
            .set_expression_attribute_names(Some(names))
            .set_expression_attribute_values(Some(marshall_map(&values)))
            .set_filter_expression(filter_expression)
            .limit(i32::try_from(pagination.limit()).unwrap_or(i32::MAX))
            .set_exclusive_start_key(start_key.map(|key| marshall_map(&key)))
            .send()
            .await?;

        let items = output
            .items()
            .iter()
            .map(|item| {
                Ok(serde_json::from_value(Value::Object(without_null_trace(
                    unmarshall_map(item),
                )))?)
            })
            .collect::<Result<_, StorageError>>()?;
        let next_token = output
            .last_evaluated_key()
            .map(|key| pagination::encode(&page_key(key, index)));

        Ok(Page {
            items,
            pagination: PageInfo { next_token },
        })
    }
}

/// A listing's filter expression, adding its names and values, or `None` when
/// nothing filters. Filters apply after a page is read, so a filtered page can hold
/// fewer items than its size (or none) while a `nextToken` continues the listing.
fn filter_expression(
    filter: &ListFilter,
    scope: Option<String>,
    names: &mut HashMap<String, String>,
    values: &mut Map<String, Value>,
) -> Option<String> {
    let mut conditions = Vec::new();

    if let Some(operation) = &filter.operation {
        conditions.push("#operation = :operation");
        names.insert("#operation".to_owned(), "operation".to_owned());
        values.insert(":operation".to_owned(), Value::String(operation.clone()));
    }

    if let Some(tier) = filter.tier {
        conditions.push("#tier = :tier");
        names.insert("#tier".to_owned(), "tier".to_owned());
        values.insert(":tier".to_owned(), Value::from(tier.get()));
    }

    if let Some(scope) = scope {
        conditions.push("contains(#scopes, :scope)");
        names.insert("#scopes".to_owned(), attributes::SCOPES.to_owned());
        values.insert(":scope".to_owned(), Value::String(scope));
    }

    (!conditions.is_empty()).then(|| conditions.join(" AND "))
}

/// A `LastEvaluatedKey` as a token key: the index's key attributes in schema order,
/// then any others, sorted.
fn page_key(key: &Item, index: Index) -> Map<String, Value> {
    let mut page_key = Map::new();
    for (name, _) in index.page_key_schema() {
        if let Some(value) = key.get(name) {
            page_key.insert(name.to_owned(), unmarshall(value));
        }
    }
    for (name, value) in unmarshall_map(key) {
        page_key.entry(name).or_insert(value);
    }
    page_key
}

/// Drops a `trace` that isn't a string: the 1.x SDK wrote an empty trace as NULL
/// (`convertEmptyValues`), which the models don't accept.
fn without_null_trace(mut item: Map<String, Value>) -> Map<String, Value> {
    if item.get("trace").is_some_and(|trace| !trace.is_string()) {
        item.shift_remove("trace");
    }
    item
}

/// A stored audit as an audit.
fn parse_item(item: Map<String, Value>) -> Result<Audit, StorageError> {
    Ok(serde_json::from_value(Value::Object(without_null_trace(
        item,
    )))?)
}
