//! The audit table: reads, upserts and listings (`AuditRepository` in the
//! TypeScript SDK). Requests match the TypeScript SDK's, recorded in
//! `contract/fixtures/sdk`.

use std::collections::HashMap;
use std::sync::Arc;

use aws_sdk_dynamodb::Client;
use aws_sdk_dynamodb::types::{AttributeValue, ReturnValue};
use lambda_kit::clock::{Clock, SystemClock};
use lambda_kit::logging::ErrorChain;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::attribute::{Item, marshall_map, unmarshall, unmarshall_map};
use crate::config::AuditConfig;
use crate::keys::{
    IncompleteResourceFilter, ReservedTenant, audit_scopes, filter_scope, fits_sort_key,
    has_resource_id, index_attributes, join_key, primary_key, related_sort_key, resource_scopes,
    tenant_key,
};
use crate::model::{Attempt, Audit, AuditSummary, ResourceReference, Status, Tier, Timestamp};
use crate::pagination::{self, InvalidNextToken, Page, PageInfo, Pagination};
use crate::table::{Index, SUMMARY_PROJECTION, attributes, keys, kinds, sort_keys};
use crate::trace::trace_parts;
use crate::upsert::{StoredAudit, UpsertAudit};

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
}

impl AuditRepository {
    /// A repository for `table`, with the config's TTL.
    pub fn new(client: Client, table: impl Into<String>, config: &AuditConfig) -> Self {
        AuditRepository {
            client,
            table: table.into(),
            ttl_seconds: config.ttl_seconds,
            clock: Arc::new(SystemClock),
        }
    }

    /// Uses `clock` for timestamps and TTLs.
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
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
    /// Likewise a `trace` without an id, empty or such as `:2`, removes `traceId`
    /// and `traceStage`, so the audit leaves its earlier trace's listing.
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

        // The target is replaced whole, so its resourceId goes with it; a trace without
        // an id clears the trace's index attributes, so the audit leaves its listing
        let mut removed = Vec::new();
        if !has_resource_id(stored.target.id.as_ref()) {
            removed.push(attributes::RESOURCE_ID);
        }
        if stored
            .trace
            .as_deref()
            .is_some_and(|trace| trace_parts(trace).0.is_empty())
        {
            removed.extend([attributes::TRACE_ID, attributes::TRACE_STAGE]);
        }
        for name in &removed {
            names.insert(format!("#{name}"), (*name).to_owned());
        }
        let remove = if removed.is_empty() {
            String::new()
        } else {
            let names: Vec<String> = removed.iter().map(|name| format!("#{name}")).collect();
            format!(" REMOVE {}", names.join(", "))
        };

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
        let listed = audit.resources.iter().flatten();
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

        if number > 1 {
            self.remove_replaced_targets(&key, attributes, listed, number)
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
    /// resources with an id.
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
    ///
    /// Each copy is put in turn, as its `revision`, the audit's attempt count, and
    /// only over a copy of the same or an earlier revision: when upserts of the
    /// audit overlap, the copy is the latest one's, whichever writes its copies last.
    ///
    /// Then the audit is read again: when a migration (`aws-audit-migrate`) merged
    /// a 1.x audit into it since it was upserted, its copies are put again from the
    /// merged audit, at its revision. A merge rewrites the copies it finds, so a
    /// copy written after it, from the audit before it, would stay otherwise. A
    /// resource missing from its `scopes` goes back, as an overlapping retry may
    /// have removed it as a target it replaced before its copy was put (see
    /// [`upsert_item`](Self::upsert_item)).
    ///
    /// A retry whose target is a resource an earlier attempt listed deletes that
    /// copy, as the audit lists under its target itself; so does an upsert that put
    /// a copy under the target a later, overlapping upsert gave the audit. Each
    /// delete leaves a copy a later upsert put.
    ///
    /// A resource whose copy's `SK` would be longer than DynamoDB allows (1,024
    /// bytes) gets no copy, with a warning, as the audit is stored already.
    pub async fn upsert_related<'a>(
        &self,
        audit: &Audit,
        related: impl IntoIterator<Item = &'a ResourceReference>,
    ) -> Result<(), StorageError> {
        let key = primary_key(
            audit.tenant_id.as_deref(),
            &audit.target.app,
            &audit.target.resource_type,
            &audit.id,
        )?;
        let revision = audit.attempts.as_ref().map_or(0, Vec::len);
        let own =
            has_resource_id(audit.target.id.as_ref()).then(|| related_sort_key(&audit.target));

        // A retry's target may be a resource an earlier attempt listed: the audit
        // lists there itself now, so that copy goes, unless its key is too long for
        // there to be one
        if let Some(own) = own
            .as_deref()
            .filter(|own| revision > 1 && fits_sort_key(own))
        {
            self.delete_related(&key, own, revision).await?;
        }

        // One copy per resource, from its last listing
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
            if !fits_sort_key(&sort_key) {
                // The audit is stored already, so it isn't refused for one listing
                tracing::warn!(
                    id = %audit.id,
                    app = %resource.app,
                    resourceType = %resource.resource_type,
                    bytes = sort_key.len(),
                    "Related resource's id is too long for a copy to list it"
                );
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

        self.put_related(audit, &key, &resources, revision).await?;

        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(marshall_map(&key)))
            .consistent_read(true)
            .send()
            .await?;
        let Some(item) = output.item() else {
            return Ok(());
        };
        // An overlapping retry removed a resource as one it replaced, before its copy was put
        let scopes = item
            .get(attributes::SCOPES)
            .and_then(|scopes| scopes.as_ss().ok())
            .map_or(&[][..], Vec::as_slice);
        let mut missing: Vec<String> = Vec::new();
        for scope in resources
            .iter()
            .flat_map(|(_, resource)| resource_scopes(resource))
        {
            if !scopes.contains(&scope) && !missing.contains(&scope) {
                missing.push(scope);
            }
        }
        self.add_scopes(&key, missing).await?;
        let current = unmarshall_map(item);
        let target = current
            .get("target")
            .and_then(|target| ResourceReference::deserialize(target).ok())
            .filter(|target| has_resource_id(target.id.as_ref()))
            .map(|target| related_sort_key(&target));

        let migrated = current
            .get(attributes::MIGRATED)
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let attempts = current
            .get("attempts")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        if migrated && attempts != revision {
            let current = parse_item(current)?;
            let others: Vec<(String, &ResourceReference)> = resources
                .iter()
                .filter(|(sort_key, _)| target.as_ref() != Some(sort_key))
                .cloned()
                .collect();
            self.put_related(&current, &key, &others, attempts).await?;
        }
        // An upsert since made one of these resources its target: the copy just put goes
        if let Some(target) = target
            .filter(|target| own.as_ref() != Some(target))
            .filter(|target| resources.iter().any(|(sort_key, _)| sort_key == target))
        {
            self.delete_related(&key, &target, revision).await?;
        }

        Ok(())
    }

    /// Deletes the copy keyed `sort_key` in the audit's partition (`key`), under a
    /// resource the audit now targets, unless a later upsert than `revision` put it.
    async fn delete_related(
        &self,
        key: &Map<String, Value>,
        sort_key: &str,
        revision: usize,
    ) -> Result<(), StorageError> {
        let mut copy = key.clone();
        copy.insert(
            keys::SORT_KEY.to_owned(),
            Value::String(sort_key.to_owned()),
        );
        let delete = self
            .client
            .delete_item()
            .table_name(&self.table)
            .set_key(Some(marshall_map(&copy)))
            .condition_expression("attribute_not_exists(#revision) OR #revision <= :revision")
            .expression_attribute_names("#revision", attributes::REVISION)
            .expression_attribute_values(":revision", AttributeValue::N(revision.to_string()))
            .send()
            .await;
        match delete {
            // A later upsert put it
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|error| error.is_conditional_check_failed_exception()) =>
            {
                Ok(())
            }
            result => result.map(|_| ()).map_err(Into::into),
        }
    }

    /// Removes from `scopes` the targets a retry replaced: each resource of the
    /// audit's app and type there (`{app}#{type}#{id}`) other than its target, in
    /// `stored`, unless the retry lists it as related (`listed`) or a related
    /// resource's copy (read consistently) lists the audit under it. Only the
    /// upsert that appended the latest attempt (`revision`) removes them, as a
    /// later one's target is its own; as they're read from `scopes`, it also
    /// removes those an earlier, overlapping retry left to it.
    ///
    /// A copy put after the check lists the audit there after all, so its resource
    /// goes back: the copies are read again once the scopes are removed, and
    /// [`upsert_related`](Self::upsert_related) adds back its resources' scopes
    /// after putting theirs.
    async fn remove_replaced_targets<'a>(
        &self,
        key: &Map<String, Value>,
        stored: &Item,
        listed: impl IntoIterator<Item = &'a ResourceReference>,
        revision: u32,
    ) -> Result<(), StorageError> {
        let Some(target) = stored
            .get("target")
            .and_then(|value| ResourceReference::deserialize(unmarshall(value)).ok())
        else {
            return Ok(());
        };
        let resource = format!(
            "{}#",
            join_key([target.app.as_str(), target.resource_type.as_str()])
        );
        let mut kept = resource_scopes(&target);
        kept.extend(listed.into_iter().flat_map(resource_scopes));
        let candidates = stored
            .get(attributes::SCOPES)
            .and_then(|scopes| scopes.as_ss().ok())
            .into_iter()
            .flatten()
            .filter(|scope| scope.starts_with(&resource) && !kept.contains(scope));

        let mut replaced = Vec::new();
        for scope in candidates {
            if !self.has_copy(key, scope).await? {
                replaced.push(scope.clone());
            }
        }
        if replaced.is_empty() {
            return Ok(());
        }

        let update = self
            .client
            .update_item()
            .table_name(&self.table)
            .set_key(Some(marshall_map(key)))
            .update_expression("DELETE #scopes :scopes")
            .condition_expression("size(#attempts) = :revision")
            .expression_attribute_names("#scopes", attributes::SCOPES)
            .expression_attribute_names("#attempts", "attempts")
            .expression_attribute_values(":scopes", AttributeValue::Ss(replaced.clone()))
            .expression_attribute_values(":revision", AttributeValue::N(revision.to_string()))
            .send()
            .await;
        match update {
            // An upsert since removes them, from the audit as it stored it
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|error| error.is_conditional_check_failed_exception()) =>
            {
                return Ok(());
            }
            result => result.map(|_| ())?,
        }

        // An overlapping upsert's copy put since the check
        let mut relisted = Vec::new();
        for scope in replaced {
            if self.has_copy(key, &scope).await? {
                relisted.push(scope);
            }
        }
        self.add_scopes(key, relisted).await
    }

    /// Whether a copy of the audit keyed `key` lists it under the resource whose
    /// `scopes` value is `scope` (`{app}#{type}#{id}`), read consistently.
    async fn has_copy(&self, key: &Map<String, Value>, scope: &str) -> Result<bool, StorageError> {
        let sort_key = format!("{}{scope}", sort_keys::RELATED_PREFIX);
        // Too long for there to be one
        if !fits_sort_key(&sort_key) {
            return Ok(false);
        }

        let mut copy = key.clone();
        copy.insert(keys::SORT_KEY.to_owned(), Value::String(sort_key));
        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(marshall_map(&copy)))
            .projection_expression("#pk")
            .expression_attribute_names("#pk", keys::PARTITION_KEY)
            .consistent_read(true)
            .send()
            .await?;
        Ok(output.item().is_some())
    }

    /// Adds `scopes` to the audit keyed `key`, unless it's gone (expired).
    async fn add_scopes(
        &self,
        key: &Map<String, Value>,
        scopes: Vec<String>,
    ) -> Result<(), StorageError> {
        if scopes.is_empty() {
            return Ok(());
        }

        let update = self
            .client
            .update_item()
            .table_name(&self.table)
            .set_key(Some(marshall_map(key)))
            .update_expression("ADD #scopes :scopes")
            .condition_expression("attribute_exists(#pk)")
            .expression_attribute_names("#scopes", attributes::SCOPES)
            .expression_attribute_names("#pk", keys::PARTITION_KEY)
            .expression_attribute_values(":scopes", AttributeValue::Ss(scopes))
            .send()
            .await;
        match update {
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|error| error.is_conditional_check_failed_exception()) =>
            {
                Ok(())
            }
            result => result.map(|_| ()).map_err(Into::into),
        }
    }

    /// Puts the copies of `audit`, keyed `key`, under `resources` (each with its
    /// sort key), in turn, as `revision`.
    async fn put_related(
        &self,
        audit: &Audit,
        key: &Map<String, Value>,
        resources: &[(String, &ResourceReference)],
        revision: usize,
    ) -> Result<(), StorageError> {
        let now = self.clock.now();
        let Value::Object(payload) = serde_json::to_value(audit)? else {
            unreachable!("an audit serializes to an object");
        };
        let summary: Map<String, Value> = payload
            .into_iter()
            .filter(|(name, _)| SUMMARY_PROJECTION.contains(&name.as_str()))
            .collect();
        let source = serde_json::to_value(&audit.target)?;
        let rerunable = audit.rerunable.unwrap_or(audit.event.is_some());

        // In turn, so a throttled table isn't hit harder
        for (sort_key, resource) in resources {
            let mut item = Map::from_iter([
                (
                    keys::PARTITION_KEY.to_owned(),
                    key[keys::PARTITION_KEY].clone(),
                ),
                (keys::SORT_KEY.to_owned(), Value::String(sort_key.clone())),
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
            item.insert(attributes::REVISION.to_owned(), Value::from(revision));

            let put = self
                .client
                .put_item()
                .table_name(&self.table)
                .set_item(Some(marshall_map(&item)))
                .condition_expression("attribute_not_exists(#revision) OR #revision <= :revision")
                .expression_attribute_names("#revision", attributes::REVISION)
                .expression_attribute_values(":revision", AttributeValue::N(revision.to_string()))
                .send()
                .await;
            match put {
                // A later upsert of the audit wrote its copy already
                Err(error)
                    if error
                        .as_service_error()
                        .is_some_and(|error| error.is_conditional_check_failed_exception()) => {}
                result => {
                    result?;
                }
            }
        }

        Ok(())
    }

    /// The TTL of an item written at `now`: epoch seconds.
    fn ttl(&self, now: chrono::DateTime<chrono::Utc>) -> i64 {
        now.timestamp_millis()
            .div_euclid(1000)
            .saturating_add_unsigned(self.ttl_seconds)
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
