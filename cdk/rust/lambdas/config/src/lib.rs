//! The `GET /config` Lambda (`config/handler.ts`): the apps, each with its
//! resource types, and the statuses audits may use, and the package version the
//! stack was deployed with.
//!
//! None of it changes while the Lambda runs, so the body is built once.

use aws_audit::AuditConfig;
use aws_audit::model::Status;
use indexmap::IndexMap;
use lambda_kit::http::{self, HttpRequest, Router};
use serde::Serialize;
use std::sync::Arc;

/// The variable the construct sets to the CDK package version.
pub const VERSION_VARIABLE: &str = "AWS_AUDIT_CDK_VERSION";

/// The construct didn't set [`VERSION_VARIABLE`].
#[derive(Debug, thiserror::Error)]
#[error("{VERSION_VARIABLE} is not set")]
pub struct MissingVersion;

/// The version from [`VERSION_VARIABLE`].
pub fn version_from_env() -> Result<String, MissingVersion> {
    std::env::var(VERSION_VARIABLE)
        .ok()
        .filter(|version| !version.is_empty())
        .ok_or(MissingVersion)
}

/// The `GET /config` body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBody {
    /// The apps audits may target, each with its resource types.
    pub apps: IndexMap<String, Vec<String>>,
    /// Every status.
    pub statuses: Vec<Status>,
    /// The CDK package version.
    pub version: String,
}

impl ConfigBody {
    /// The body for `config`, deployed as `version`.
    pub fn new(config: &AuditConfig, version: String) -> Self {
        ConfigBody {
            apps: config.apps.clone(),
            statuses: Status::ALL.to_vec(),
            version,
        }
    }
}

/// The Lambda's routes.
pub fn router(body: ConfigBody) -> Router<ConfigBody> {
    Router::new(body).get("/config", get)
}

async fn get(body: Arc<ConfigBody>, _request: HttpRequest) -> http::Result {
    Ok(http::json(200, &*body))
}
