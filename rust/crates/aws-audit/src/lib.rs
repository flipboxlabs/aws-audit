//! Core of the aws-audit Lambdas: the audit model, config, resource names, table
//! layout and pagination tokens.
//!
//! The TypeScript SDK (`@flipboxlabs/aws-audit-sdk`) writes the same table, so this
//! crate follows it exactly. `contract/` at the repository root records what the
//! TypeScript code sends and returns; the tests here check against it.

pub mod attribute;
pub mod config;
pub mod events;
pub mod id;
pub mod js;
pub mod keys;
pub mod model;
pub mod names;
pub mod pagination;
pub mod service;
pub mod storage;
pub mod table;
pub mod upsert;

pub use config::AuditConfig;
pub use model::{
    Attempt, Audit, Context, EventBridgeEvent, ResourceId, ResourceReference, Status, Tier,
};
pub use pagination::{InvalidNextToken, Page, PageKey, Pagination};
