//! Audits for Rust Lambdas, and the core of the aws-audit Lambdas.
//!
//! An app records audits with [`log::Audits`], which logs them for the audit
//! stack to store; that's all the default features include. The `sqs` feature adds
//! helpers for auditing SQS messages ([`sqs`]), and the `service` feature reads and
//! writes the audit table and event bus directly ([`service::AuditService`]), as
//! the audit stack's own Lambdas do.
//!
//! The TypeScript SDK (`@flipboxlabs/aws-audit-sdk`) writes the same logs and
//! table, so this crate follows it exactly. `contract/` at the repository root
//! records what the TypeScript code sends and returns; the tests here check against
//! it.

#[cfg(feature = "service")]
pub mod attribute;
pub mod config;
#[cfg(feature = "service")]
pub mod events;
pub mod id;
pub mod js;
#[cfg(feature = "service")]
pub mod keys;
pub mod log;
pub mod model;
pub mod names;
#[cfg(feature = "service")]
pub mod pagination;
pub mod rerun;
#[cfg(feature = "service")]
pub mod service;
#[cfg(feature = "sqs")]
pub mod sqs;
#[cfg(feature = "service")]
pub mod storage;
#[cfg(feature = "service")]
pub mod table;
#[cfg(feature = "testing")]
pub mod testing;
pub mod trace;
pub mod upsert;

pub use config::AuditConfig;
pub use log::{Audits, LogAudit};
pub use model::{
    Attempt, Audit, AuditSummary, Context, EventBridgeEvent, ResourceId, ResourceReference, Status,
    Tier, is_rerunable,
};
#[cfg(feature = "service")]
pub use pagination::{InvalidNextToken, Page, PageKey, Pagination};
