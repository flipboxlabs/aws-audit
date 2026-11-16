//! The audit table: reads, upserts and listings (`AuditRepository` in the
//! TypeScript SDK). Requests match the TypeScript SDK's, recorded in
//! `contract/fixtures/sdk`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::types::{KeysAndAttributes, PutRequest, ReturnValue, WriteRequest};
use lambda_kit::clock::{Clock, SystemClock};
use lambda_kit::retry::{Backoff, Jitter, RandomJitter};
use serde_json::{Map, Value};

use crate::attribute::{Item, Marshall, unmarshall, unmarshall_map};
use crate::config::AuditConfig;
use crate::keys::{partition, primary_key, resolve_trace, secondary_keys};
use crate::model::{Attempt, Audit, Status, Timestamp};
use crate::pagination::{self, InvalidNextToken, Page, PageInfo, Pagination};
use crate::table::{Index, LISTING_PROJECTION, keys};
use crate::upsert::{StoredAudit, UpsertAudit};

/// Items per `BatchWriteItem` request (DynamoDB's limit).
const WRITE_BATCH_SIZE: usize = 25;

/// Keys per `BatchGetItem` request (DynamoDB's limit).
const GET_BATCH_SIZE: usize = 100;

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
    /// A batch still had unprocessed items after every retry.
    #[error("{operation} failed: unprocessed {noun} after {retries} retries")]
    Unprocessed {
        /// `BatchWriteItem` or `BatchGetItem`.
        operation: &'static str,
        /// What was left: `items` or `keys`.
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

/// What a filtered listing (trace or status) keeps: audits whose target matches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetFilter {
    /// The target's app.
    pub app: Option<String>,
    /// The target's resource type.
    pub resource_type: Option<String>,
    /// The target's id.
    pub resource_id: Option<String>,
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

    /// Uses `clock` for timestamps, index keys and TTLs.
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
        );

        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(Marshall::ITEM.map(&key)))
            .send()
            .await
            .map_err(|error| {
                let error = StorageError::from(error);
                tracing::error!(?identifiers, error = %error, "Failed to read audit item");
                error
            })?;

        output
            .item()
            .map(|item| transform_item(unmarshall_map(item)))
            .transpose()
    }

    /// Creates or updates the audit `id`, appending `attempt` to its attempts, and
    /// returns the attempt's number: its position in the stored list, which differs
    /// from `attempt.number` on a retry.
    pub async fn upsert_item(
        &self,
        audit: &UpsertAudit,
        id: &str,
        attempt: &Attempt,
    ) -> Result<u32, StorageError> {
        let now = self.clock.now();
        let stored = StoredAudit::new(audit, id.to_owned(), &Timestamp::from(now));
        let key = primary_key(
            stored.tenant_id.as_deref(),
            &stored.target.app,
            &stored.target.resource_type,
            &stored.id,
        );

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
        let fields = payload.into_iter().chain(secondary_keys(
            &stored,
            now.timestamp_millis(),
            self.ttl_seconds,
        ));
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

        let output = self
            .client
            .update_item()
            .table_name(&self.table)
            .set_key(Some(Marshall::ITEM.map(&key)))
            .update_expression(format!("SET {}", clauses.join(", ")))
            .set_expression_attribute_names(Some(names))
            .set_expression_attribute_values(Some(Marshall::ITEM.map(&values)))
            .return_values(ReturnValue::AllNew)
            .send()
            .await?;

        let attempts = output
            .attributes()
            .and_then(|attributes| attributes.get("attempts"))
            .and_then(|attempts| attempts.as_l().ok())
            .ok_or(StorageError::MissingAttributes)?;
        let number = u32::try_from(attempts.len()).unwrap_or(u32::MAX);

        // A retry appended to earlier attempts: renumber this one by its position
        if number != attempt.number {
            self.client
                .update_item()
                .table_name(&self.table)
                .set_key(Some(Marshall::ITEM.map(&key)))
                .update_expression(format!(
                    "SET #attempts[{}].#number = :attemptNumber",
                    number - 1
                ))
                .expression_attribute_names("#attempts", "attempts")
                .expression_attribute_names("#number", "number")
                .set_expression_attribute_values(Some(Marshall::PLAIN.map(&Map::from_iter([(
                    ":attemptNumber".to_owned(),
                    Value::from(number),
                )]))))
                .send()
                .await?;
        }

        Ok(number)
    }

    /// Writes audits whole (no attempt tracking), 25 per `BatchWriteItem`, retrying
    /// unprocessed items. Used for related-resource copies.
    pub async fn upsert_batch(&self, audits: &[UpsertAudit]) -> Result<(), StorageError> {
        let now = self.clock.now();
        let timestamp = Timestamp::from(now);

        let mut requests = Vec::with_capacity(audits.len());
        for audit in audits {
            let id = audit.id.clone().unwrap_or_else(crate::id::generate);
            let stored = StoredAudit::new(audit, id, &timestamp);

            let mut item = primary_key(
                stored.tenant_id.as_deref(),
                &stored.target.app,
                &stored.target.resource_type,
                &stored.id,
            );
            item.extend(secondary_keys(
                &stored,
                now.timestamp_millis(),
                self.ttl_seconds,
            ));
            let Value::Object(payload) = serde_json::to_value(&stored)? else {
                unreachable!("an audit serializes to an object");
            };
            item.extend(payload);

            requests.push(
                WriteRequest::builder()
                    .put_request(
                        PutRequest::builder()
                            .set_item(Some(Marshall::ITEM.map(&item)))
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
                delay_ms = delay.as_millis() as u64,
                "BatchWriteItem: retrying unprocessed items"
            );
            tokio::time::sleep(delay).await;
            pending = unprocessed;
        }
    }

    /// Reads `keys` with `attributes` projected, 100 per `BatchGetItem`, retrying
    /// unprocessed keys. Items come back in no particular order.
    async fn get_batch(
        &self,
        keys: &[Map<String, Value>],
        attributes: &[&str],
    ) -> Result<Vec<Map<String, Value>>, StorageError> {
        let names: HashMap<String, String> = attributes
            .iter()
            .enumerate()
            .map(|(i, attribute)| (format!("#a{i}"), (*attribute).to_owned()))
            .collect();
        let projection = (0..attributes.len())
            .map(|i| format!("#a{i}"))
            .collect::<Vec<_>>()
            .join(", ");

        let mut items = Vec::new();
        for chunk in keys.chunks(GET_BATCH_SIZE) {
            let mut pending: Vec<Item> = chunk.iter().map(|key| Marshall::PLAIN.map(key)).collect();
            let mut attempt = 0;

            loop {
                let request = KeysAndAttributes::builder()
                    .set_keys(Some(pending))
                    .projection_expression(&projection)
                    .set_expression_attribute_names(Some(names.clone()))
                    .build()?;
                let output = self
                    .client
                    .batch_get_item()
                    .request_items(&self.table, request)
                    .send()
                    .await?;

                if let Some(found) = output
                    .responses()
                    .and_then(|responses| responses.get(&self.table))
                {
                    items.extend(found.iter().map(unmarshall_map));
                }

                let unprocessed: Vec<Item> = output
                    .unprocessed_keys()
                    .and_then(|keys| keys.get(&self.table))
                    .map(|keys| keys.keys().to_vec())
                    .unwrap_or_default();
                if unprocessed.is_empty() {
                    break;
                }

                attempt += 1;
                if attempt > BATCH_RETRIES {
                    tracing::error!(
                        count = unprocessed.len(),
                        attempt,
                        "BatchGetItem: unprocessed keys remain after max retries"
                    );
                    return Err(StorageError::Unprocessed {
                        operation: "BatchGetItem",
                        noun: "keys",
                        retries: BATCH_RETRIES,
                    });
                }

                let delay = self.backoff.delay(attempt, self.jitter.sample());
                tracing::warn!(
                    count = unprocessed.len(),
                    attempt,
                    delay_ms = delay.as_millis() as u64,
                    "BatchGetItem: retrying unprocessed keys"
                );
                tokio::time::sleep(delay).await;
                pending = unprocessed;
            }
        }

        Ok(items)
    }

    /// Audits of a resource type, by tier then most recent write.
    pub async fn list_objects(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, StorageError> {
        let pk = partition(tenant_id, &format!("{app}.{resource_type}"));
        let (items, next_token) = self
            .query(Index::Lsi1N, &pk, false, None, pagination)
            .await?;

        Ok(Page {
            items: items
                .into_iter()
                .map(|item| transform_list_item(item, tenant_id, true))
                .collect::<Result<_, _>>()?,
            pagination: PageInfo { next_token },
        })
    }

    /// Audits of one resource, most recent first.
    pub async fn list_items(
        &self,
        tenant_id: Option<&str>,
        app: &str,
        resource_type: &str,
        resource_id: &str,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, StorageError> {
        let pk = partition(tenant_id, &format!("{app}.{resource_type}#{resource_id}"));
        let (items, next_token) = self
            .query(Index::Gsi1Ss, &pk, false, None, pagination)
            .await?;

        Ok(Page {
            items: items
                .into_iter()
                .map(|item| transform_list_item(item, tenant_id, true))
                .collect::<Result<_, _>>()?,
            pagination: PageInfo { next_token },
        })
    }

    /// Audits of a trace, by stage. Related-resource copies are listed as their
    /// parent audit.
    pub async fn list_trace_items(
        &self,
        tenant_id: Option<&str>,
        trace: &str,
        filter: &TargetFilter,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, StorageError> {
        let pk = partition(tenant_id, trace);
        let (items, next_token) = self
            .query(Index::Gsi1Sn, &pk, true, Some(filter), pagination)
            .await?;
        let items = self
            .resolve_related(
                items,
                keys::GSI1_SN_PARTITION_KEY,
                &pk,
                &[keys::GSI1_SN_PARTITION_KEY, keys::GSI1_SN_SORT_KEY],
                tenant_id,
            )
            .await?;

        Ok(Page {
            items: items
                .into_iter()
                .map(|item| transform_list_item(item, tenant_id, true))
                .collect::<Result<_, _>>()?,
            pagination: PageInfo { next_token },
        })
    }

    /// Audits with a status, most recent first. Related-resource copies are listed
    /// as their parent audit.
    pub async fn list_by_status(
        &self,
        tenant_id: Option<&str>,
        status: Status,
        filter: &TargetFilter,
        pagination: &Pagination,
    ) -> Result<Page<Audit>, StorageError> {
        let pk = partition(tenant_id, status.as_str());
        let (items, next_token) = self
            .query(Index::Gsi2Ss, &pk, false, Some(filter), pagination)
            .await?;
        let items = self
            .resolve_related(
                items,
                keys::GSI2_SS_PARTITION_KEY,
                &pk,
                &[keys::GSI2_SS_PARTITION_KEY, keys::GSI2_SS_SORT_KEY],
                tenant_id,
            )
            .await?;

        Ok(Page {
            items: items
                .into_iter()
                .map(|item| transform_list_item(item, tenant_id, false))
                .collect::<Result<_, _>>()?,
            pagination: PageInfo { next_token },
        })
    }

    /// Queries one page of `index`'s partition `pk`.
    async fn query(
        &self,
        index: Index,
        pk: &str,
        forward: bool,
        filter: Option<&TargetFilter>,
        pagination: &Pagination,
    ) -> Result<(Vec<Map<String, Value>>, Option<String>), StorageError> {
        let start_key =
            pagination::exclusive_start_key(pagination.next_token.as_deref(), index, pk)?;

        let mut names = HashMap::from([("#PK".to_owned(), index.partition_key().to_owned())]);
        let mut values = Map::from_iter([(":PK".to_owned(), Value::String(pk.to_owned()))]);
        let filter_expression = filter.map(|filter| target_filter(filter, &mut names, &mut values));

        let output = self
            .client
            .query()
            .table_name(&self.table)
            .index_name(index.name())
            .key_condition_expression("#PK=:PK")
            .set_expression_attribute_names(Some(names))
            .set_expression_attribute_values(Some(Marshall::PLAIN.map(&values)))
            .scan_index_forward(forward)
            .limit(i32::try_from(pagination.limit()).unwrap_or(i32::MAX))
            .set_exclusive_start_key(start_key.map(|key| Marshall::PLAIN.map(&key)))
            .set_filter_expression(filter_expression)
            .send()
            .await?;

        let items = output.items().iter().map(unmarshall_map).collect();
        let next_token = output
            .last_evaluated_key()
            .map(|key| pagination::encode(&page_key(key, index)));

        Ok((items, next_token))
    }

    /// Replaces related-resource copies (`SK` `{parentId}#…`) with their parent
    /// audit, once per page, reading parents not on the page. A parent outside the
    /// queried partition (`partition_key` = `partition_value`), or a copy without a
    /// source, is skipped.
    async fn resolve_related(
        &self,
        items: Vec<Map<String, Value>>,
        partition_key: &str,
        partition_value: &str,
        partition_attributes: &[&str],
        tenant_id: Option<&str>,
    ) -> Result<Vec<Map<String, Value>>, StorageError> {
        let sort_key = |item: &Map<String, Value>| {
            item.get(keys::SORT_KEY)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        let is_related = |item: &Map<String, Value>| sort_key(item).contains('#');
        if !items.iter().any(is_related) {
            return Ok(items);
        }

        let key_of = |key: &Map<String, Value>| {
            (
                key.get(keys::PARTITION_KEY)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                key.get(keys::SORT_KEY)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )
        };

        // The table key of the audit each row lists
        let parent_keys: Vec<Option<Map<String, Value>>> = items
            .iter()
            .map(|item| {
                if !is_related(item) {
                    return Some(primary_key_of(item));
                }
                let source = item.get("source")?.as_object()?;
                let sk = sort_key(item);
                let parent_id = sk.split('#').next().unwrap_or_default();
                Some(primary_key(
                    tenant_id,
                    source.get("app")?.as_str()?,
                    source.get("type")?.as_str()?,
                    parent_id,
                ))
            })
            .collect();

        let mut parents: HashMap<(String, String), Map<String, Value>> = items
            .iter()
            .filter(|item| !is_related(item))
            .map(|item| (key_of(item), item.clone()))
            .collect();

        let mut seen = HashSet::new();
        let missing: Vec<Map<String, Value>> = parent_keys
            .iter()
            .flatten()
            .filter(|key| !parents.contains_key(&key_of(key)) && seen.insert(key_of(key)))
            .cloned()
            .collect();

        if !missing.is_empty() {
            let attributes: Vec<&str> = [keys::PARTITION_KEY, keys::SORT_KEY]
                .into_iter()
                .chain(partition_attributes.iter().copied())
                .chain(LISTING_PROJECTION)
                .collect();
            for parent in self.get_batch(&missing, &attributes).await? {
                if parent.get(partition_key).and_then(Value::as_str) == Some(partition_value) {
                    parents.insert(key_of(&parent), parent);
                }
            }
        }

        let mut listed = HashSet::new();
        let mut resolved = Vec::with_capacity(items.len());
        for (item, key) in items.iter().zip(&parent_keys) {
            let Some(parent) = key
                .as_ref()
                .map(key_of)
                .and_then(|key| parents.get(&key).map(|parent| (key, parent)))
            else {
                tracing::debug!(sk = %sort_key(item), "Skipping related audit without a listable parent");
                continue;
            };
            if listed.insert(parent.0) {
                resolved.push(parent.1.clone());
            }
        }

        Ok(resolved)
    }
}

/// The filter expression for a target filter, adding its names and values. Without
/// any criteria, it excludes related-resource copies.
fn target_filter(
    filter: &TargetFilter,
    names: &mut HashMap<String, String>,
    values: &mut Map<String, Value>,
) -> String {
    let mut clauses = Vec::new();
    let criteria = [
        (&filter.resource_id, ":resourceId", "#id", "id"),
        (&filter.resource_type, ":resourceType", "#type", "type"),
        (&filter.app, ":app", "#app", "app"),
    ];

    for (value, placeholder, name, attribute) in criteria {
        let Some(value) = value.as_deref().filter(|value| !value.is_empty()) else {
            continue;
        };
        values.insert(placeholder.to_owned(), Value::String(value.to_owned()));
        names.insert("#target".to_owned(), "target".to_owned());
        names.insert(name.to_owned(), attribute.to_owned());
        clauses.push(format!("#target.{name} = {placeholder}"));
    }

    if clauses.is_empty() {
        values.insert(":isParent".to_owned(), Value::String("#".to_owned()));
        clauses.push("not contains(SK, :isParent)".to_owned());
    }

    clauses.join(" AND ")
}

/// A `LastEvaluatedKey` as a token key: the index's key attributes in schema order,
/// then any others, sorted.
fn page_key(key: &Item, index: Index) -> Map<String, Value> {
    let mut page_key = Map::new();
    for (name, _) in index.page_key_schema() {
        if let Some(value) = key.get(*name) {
            page_key.insert((*name).to_owned(), unmarshall(value));
        }
    }
    for (name, value) in unmarshall_map(key) {
        page_key.entry(name).or_insert(value);
    }
    page_key
}

fn primary_key_of(item: &Map<String, Value>) -> Map<String, Value> {
    [keys::PARTITION_KEY, keys::SORT_KEY]
        .into_iter()
        .filter_map(|name| item.get(name).map(|value| (name.to_owned(), value.clone())))
        .collect()
}

/// A stored item as an audit: the trace rebuilt from its keys, and the id the last
/// segment of its `id`.
fn transform_item(mut item: Map<String, Value>) -> Result<Audit, StorageError> {
    resolve_trace(&mut item, None);
    if let Some(id) = item.get("id").and_then(Value::as_str) {
        let id = id.rsplit('#').next().unwrap_or(id).to_owned();
        item.insert("id".to_owned(), Value::String(id));
    }
    Ok(serde_json::from_value(Value::Object(item))?)
}

/// A listed item as an audit: the id the first segment of its `SK`, and (unless
/// `trace` is false) the trace rebuilt from its keys.
fn transform_list_item(
    mut item: Map<String, Value>,
    tenant_id: Option<&str>,
    trace: bool,
) -> Result<Audit, StorageError> {
    if trace {
        resolve_trace(&mut item, tenant_id);
    }
    let id = item
        .get(keys::SORT_KEY)
        .and_then(Value::as_str)
        .map(|sk| sk.split('#').next().unwrap_or(sk).to_owned());
    if let Some(id) = id {
        item.insert("id".to_owned(), Value::String(id));
    }
    Ok(serde_json::from_value(Value::Object(item))?)
}
