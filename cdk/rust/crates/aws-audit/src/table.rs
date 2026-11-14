//! The audit table's layout: key attributes, indexes and projections
//! (`DynamoDB` in `sdk/src/constants.ts`, and the CDK `AuditTable`).

use crate::pagination::{KeyType, PageKeySchema};

/// Key attribute names.
pub mod keys {
    /// Table partition key: `[{tenantId}#]{app}.{type}`.
    pub const PARTITION_KEY: &str = "PK";
    /// Table sort key: the audit id (or `{parentId}#{app}.{type}#{id}` for a related
    /// resource's copy).
    pub const SORT_KEY: &str = "SK";
    /// `GSI1_SS` partition key: `[{tenantId}#]{app}.{type}#{resourceId}`.
    pub const GSI1_SS_PARTITION_KEY: &str = "GSI1_SS_PK";
    /// `GSI1_SS` sort key: the audit id.
    pub const GSI1_SS_SORT_KEY: &str = "GSI1_SS_SK";
    /// `GSI1_SN` partition key: `[{tenantId}#]{traceId}`.
    pub const GSI1_SN_PARTITION_KEY: &str = "GSI1_SN_PK";
    /// `GSI1_SN` sort key: the trace stage (a number).
    pub const GSI1_SN_SORT_KEY: &str = "GSI1_SN_SK";
    /// `LSI1_S` sort key.
    pub const LSI1_S_SORT_KEY: &str = "LSI1_S_SK";
    /// `LSI1_N` sort key: tier and creation time (a number).
    pub const LSI1_N_SORT_KEY: &str = "LSI1_N_SK";
    /// `GSI2_SS` partition key: `[{tenantId}#]{status}`.
    pub const GSI2_SS_PARTITION_KEY: &str = "GSI2_SS_PK";
    /// `GSI2_SS` sort key: `{createdAt}#{id}`.
    pub const GSI2_SS_SORT_KEY: &str = "GSI2_SS_SK";
}

/// The TTL attribute: expiry in epoch seconds.
pub const TTL_ATTRIBUTE: &str = "ttl";

/// The attributes the listing indexes project, besides the keys.
pub const LISTING_PROJECTION: [&str; 7] = [
    "operation",
    "status",
    "message",
    "source",
    "target",
    "rerunable",
    "createdAt",
];

const TABLE_KEYS: [(&str, KeyType); 2] = [
    (keys::PARTITION_KEY, KeyType::String),
    (keys::SORT_KEY, KeyType::String),
];

/// The indexes the listings query.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Index {
    /// Audits of a resource type, by tier and age.
    Lsi1N,
    /// Audits of one resource.
    Gsi1Ss,
    /// Audits of a trace, by stage.
    Gsi1Sn,
    /// Audits by status, by age.
    Gsi2Ss,
}

impl Index {
    /// The index name.
    pub fn name(self) -> &'static str {
        match self {
            Index::Lsi1N => "LSI1_N",
            Index::Gsi1Ss => "GSI1_SS",
            Index::Gsi1Sn => "GSI1_SN",
            Index::Gsi2Ss => "GSI2_SS",
        }
    }

    /// The attribute the index is partitioned by.
    pub fn partition_key(self) -> &'static str {
        match self {
            Index::Lsi1N => keys::PARTITION_KEY,
            Index::Gsi1Ss => keys::GSI1_SS_PARTITION_KEY,
            Index::Gsi1Sn => keys::GSI1_SN_PARTITION_KEY,
            Index::Gsi2Ss => keys::GSI2_SS_PARTITION_KEY,
        }
    }

    /// The attributes of the index's `LastEvaluatedKey`, in the order tokens list
    /// them: the table keys, then the index's own.
    pub fn page_key_schema(self) -> PageKeySchema {
        const LSI1_N: [(&str, KeyType); 3] = [
            TABLE_KEYS[0],
            TABLE_KEYS[1],
            (keys::LSI1_N_SORT_KEY, KeyType::Number),
        ];
        const GSI1_SS: [(&str, KeyType); 4] = [
            TABLE_KEYS[0],
            TABLE_KEYS[1],
            (keys::GSI1_SS_PARTITION_KEY, KeyType::String),
            (keys::GSI1_SS_SORT_KEY, KeyType::String),
        ];
        const GSI1_SN: [(&str, KeyType); 4] = [
            TABLE_KEYS[0],
            TABLE_KEYS[1],
            (keys::GSI1_SN_PARTITION_KEY, KeyType::String),
            (keys::GSI1_SN_SORT_KEY, KeyType::Number),
        ];
        const GSI2_SS: [(&str, KeyType); 4] = [
            TABLE_KEYS[0],
            TABLE_KEYS[1],
            (keys::GSI2_SS_PARTITION_KEY, KeyType::String),
            (keys::GSI2_SS_SORT_KEY, KeyType::String),
        ];

        match self {
            Index::Lsi1N => &LSI1_N,
            Index::Gsi1Ss => &GSI1_SS,
            Index::Gsi1Sn => &GSI1_SN,
            Index::Gsi2Ss => &GSI2_SS,
        }
    }
}
