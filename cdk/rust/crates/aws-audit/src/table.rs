//! The audit table's layout: items, index attributes, indexes and projections
//! (`DynamoDB` in `sdk/src/constants.ts`, and the CDK `AuditTable`).
//!
//! - An audit: `PK` `{tenantKey}#{app}#{type}#{id}`, `SK` `audit`, with
//!   [`NO_TENANT`] as the `tenantKey` of an audit without a tenant
//! - A copy of it per related resource, in the same partition: `SK`
//!   `related#{app}#{type}#{resourceId}`, with the resource as `target` and the
//!   audit's target as `source`
//!
//! Each part of a key is escaped: `%`, `#` and `*` as `%25`, `%23` and `%2A`
//! ([`join_key`](crate::keys::join_key)), so distinct parts never join to the same
//! key.
//!
//! The indexes use multi-attribute keys built from top-level attributes
//! ([`attributes`]), and each projects [`SUMMARY_PROJECTION`].

use crate::pagination::KeyType;

/// Table key attribute names.
pub mod keys {
    /// Table partition key: `{tenantKey}#{app}#{type}#{id}`.
    pub const PARTITION_KEY: &str = "PK";
    /// Table sort key: [`AUDIT`](super::sort_keys::AUDIT), or a related
    /// resource's copy.
    pub const SORT_KEY: &str = "SK";
}

/// Sort key values.
pub mod sort_keys {
    /// The audit itself.
    pub const AUDIT: &str = "audit";
    /// Prefix of a related-resource copy: `related#{app}#{type}#{resourceId}`.
    pub const RELATED_PREFIX: &str = "related#";
}

/// What an item is: an audit, which gets the `kind` attribute, or a related
/// resource's copy.
pub mod kinds {
    /// An audit.
    pub const AUDIT: &str = "audit";
    /// A related resource's copy of an audit.
    pub const RELATED: &str = "related";
}

/// Top-level attributes the index keys are built from.
pub mod attributes {
    /// Expiry in epoch seconds.
    pub const TTL: &str = "ttl";
    /// The audit's `tenantId`, or [`NO_TENANT`](super::NO_TENANT) without one.
    pub const TENANT_KEY: &str = "tenantKey";
    /// The item's `target.app`.
    pub const APP: &str = "app";
    /// The item's `target.type`.
    pub const RESOURCE_TYPE: &str = "resourceType";
    /// The item's `target.id`, as a string; absent when the target has none.
    pub const RESOURCE_ID: &str = "resourceId";
    /// [`kinds::AUDIT`](super::kinds::AUDIT) on an audit; a related resource's copy
    /// has none, so `ByStatus` holds audits only.
    pub const KIND: &str = "kind";
    /// The trace id from `trace`; only audits with a trace have it.
    pub const TRACE_ID: &str = "traceId";
    /// The trace stage from `trace`, a number.
    pub const TRACE_STAGE: &str = "traceStage";
    /// String set of what the status and trace filters match on, for the target
    /// and each related resource: `{app}`, `{app}#{type}`, `*#{type}` and, with an
    /// id, `{app}#{type}#{id}`, each part escaped as in the table's keys.
    pub const SCOPES: &str = "scopes";
    /// `true` on an audit the migration from the earlier table wrote or merged, so
    /// a later run leaves it alone; not projected or returned.
    pub const MIGRATED: &str = "migrated";
    /// On a related resource's copy, its audit's attempt count when the copy was
    /// written: a copy is put only over one of the same or an earlier revision, so
    /// overlapping upserts leave the latest one's; not projected or returned.
    pub const REVISION: &str = "revision";
    /// On an audit, its `target` before its latest upsert, which that upsert set in
    /// the same write: a retry that changes the target removes the earlier one's
    /// scope by it; not projected or returned.
    pub const PREVIOUS_TARGET: &str = "previousTarget";
    /// The latest outcome.
    pub const STATUS: &str = "status";
    /// When the audit was created.
    pub const CREATED_AT: &str = "createdAt";
    /// The audit id.
    pub const ID: &str = "id";
}

pub use crate::model::NO_TENANT;

/// The summary attributes a listing returns (`AuditSummarySchema`). Each index
/// projects those that aren't its keys.
pub const SUMMARY_PROJECTION: [&str; 13] = [
    "id",
    "tenantId",
    "status",
    "tier",
    "operation",
    "message",
    "target",
    "source",
    "rerunable",
    "related",
    "trace",
    "createdAt",
    "updatedAt",
];

/// A key attribute and its type.
pub type KeyAttribute = (&'static str, KeyType);

const fn string(name: &'static str) -> KeyAttribute {
    (name, KeyType::String)
}

/// Newest first, then by id so audits created in the same millisecond keep an order.
const BY_CREATION: [KeyAttribute; 2] = [string(attributes::CREATED_AT), string(attributes::ID)];

/// The indexes the listings query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Index {
    /// Audits and related-resource copies of a resource type, newest first.
    ByType,
    /// Audits and related-resource copies of a resource, newest first.
    ByResource,
    /// Audits by status, newest first; sparse, since copies have no `kind`.
    ByStatus,
    /// Audits by trace, by stage then creation; sparse, since copies have no
    /// trace id.
    ByTrace,
}

impl Index {
    /// Every index.
    pub const ALL: [Index; 4] = [
        Index::ByType,
        Index::ByResource,
        Index::ByStatus,
        Index::ByTrace,
    ];

    /// The index name.
    pub fn name(self) -> &'static str {
        match self {
            Index::ByType => "ByType",
            Index::ByResource => "ByResource",
            Index::ByStatus => "ByStatus",
            Index::ByTrace => "ByTrace",
        }
    }

    /// The partition key attributes, in key order.
    pub fn partition_keys(self) -> &'static [KeyAttribute] {
        const BY_TYPE: [KeyAttribute; 3] = [
            string(attributes::TENANT_KEY),
            string(attributes::APP),
            string(attributes::RESOURCE_TYPE),
        ];
        const BY_RESOURCE: [KeyAttribute; 4] = [
            string(attributes::TENANT_KEY),
            string(attributes::APP),
            string(attributes::RESOURCE_TYPE),
            string(attributes::RESOURCE_ID),
        ];
        const BY_STATUS: [KeyAttribute; 3] = [
            string(attributes::TENANT_KEY),
            string(attributes::STATUS),
            string(attributes::KIND),
        ];
        const BY_TRACE: [KeyAttribute; 2] =
            [string(attributes::TENANT_KEY), string(attributes::TRACE_ID)];

        match self {
            Index::ByType => &BY_TYPE,
            Index::ByResource => &BY_RESOURCE,
            Index::ByStatus => &BY_STATUS,
            Index::ByTrace => &BY_TRACE,
        }
    }

    /// The sort key attributes, in key order.
    pub fn sort_keys(self) -> &'static [KeyAttribute] {
        const BY_TRACE: [KeyAttribute; 3] = [
            (attributes::TRACE_STAGE, KeyType::Number),
            BY_CREATION[0],
            BY_CREATION[1],
        ];

        match self {
            Index::ByType | Index::ByResource | Index::ByStatus => &BY_CREATION,
            Index::ByTrace => &BY_TRACE,
        }
    }

    /// The attributes of the index's `LastEvaluatedKey`, in the order tokens list
    /// them: the table keys, then the index's partition and sort keys.
    pub fn page_key_schema(self) -> Vec<KeyAttribute> {
        [string(keys::PARTITION_KEY), string(keys::SORT_KEY)]
            .into_iter()
            .chain(self.partition_keys().iter().copied())
            .chain(self.sort_keys().iter().copied())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_table_keys_then_the_index_keys() {
        let names: Vec<_> = Index::ByTrace
            .page_key_schema()
            .into_iter()
            .map(|(name, _)| name)
            .collect();

        assert_eq!(
            names,
            [
                "PK",
                "SK",
                "tenantKey",
                "traceId",
                "traceStage",
                "createdAt",
                "id"
            ]
        );
    }
}
