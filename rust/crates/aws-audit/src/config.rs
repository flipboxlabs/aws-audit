//! The apps and resource types an audit stack accepts.
//!
//! The CDK `AuditConfigLayer` writes them to `/opt/audit-config.json` for Rust
//! Lambdas (the Node handlers import `audit-config.mjs` from the same layer).

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Default record TTL: 90 days, in seconds.
pub const DEFAULT_TTL_SECONDS: u64 = 60 * 60 * 24 * 90;

/// Where the config layer puts the config.
pub const DEFAULT_PATH: &str = "/opt/audit-config.json";

/// Overrides [`DEFAULT_PATH`], e.g. for local runs.
pub const PATH_VARIABLE: &str = "AUDIT_CONFIG_PATH";

/// An audit stack's config (`defineAuditConfig` in the TypeScript SDK).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditConfig {
    /// The apps audits may target.
    pub apps: Vec<String>,
    /// The resource types audits may target.
    pub resource_types: Vec<String>,
    /// The service name; the `SERVICE` environment variable when absent.
    #[serde(default)]
    pub service: Option<String>,
    /// How long records live, in seconds.
    #[serde(default = "default_ttl_seconds")]
    pub ttl_seconds: u64,
}

fn default_ttl_seconds() -> u64 {
    DEFAULT_TTL_SECONDS
}

/// The config file couldn't be read or isn't a valid config.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The file couldn't be read.
    #[error("unable to read the audit config at {path}: {source}")]
    Read {
        /// The file.
        path: PathBuf,
        /// Why.
        source: std::io::Error,
    },
    /// The file isn't a valid config.
    #[error("invalid audit config at {path}: {source}")]
    Parse {
        /// The file.
        path: PathBuf,
        /// Why.
        source: serde_json::Error,
    },
    /// The config lists no apps or no resource types.
    #[error("invalid audit config at {path}: {message}")]
    Invalid {
        /// The file.
        path: PathBuf,
        /// What's wrong.
        message: String,
    },
}

impl AuditConfig {
    /// Loads the config from `$AUDIT_CONFIG_PATH`, or [`DEFAULT_PATH`].
    pub fn load() -> Result<Self, ConfigError> {
        let path = std::env::var_os(PATH_VARIABLE)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_PATH));

        Self::from_file(&path)
    }

    /// Loads the config from a JSON file.
    pub fn from_file(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read {
            path: path.to_owned(),
            source,
        })?;
        let config: AuditConfig =
            serde_json::from_str(&text).map_err(|source| ConfigError::Parse {
                path: path.to_owned(),
                source,
            })?;

        // zod's z.enum() can't be built from an empty list
        for (name, values) in [
            ("apps", &config.apps),
            ("resourceTypes", &config.resource_types),
        ] {
            if values.is_empty() {
                return Err(ConfigError::Invalid {
                    path: path.to_owned(),
                    message: format!("{name} must list at least one value"),
                });
            }
        }

        Ok(config)
    }

    /// Whether `app` is one of the configured apps.
    pub fn is_app(&self, app: &str) -> bool {
        self.apps.iter().any(|candidate| candidate == app)
    }

    /// Whether `resource_type` is one of the configured resource types.
    pub fn is_resource_type(&self, resource_type: &str) -> bool {
        self.resource_types
            .iter()
            .any(|candidate| candidate == resource_type)
    }

    /// The service name: the configured one, else `$SERVICE`.
    pub fn service(&self) -> Option<String> {
        self.service
            .clone()
            .or_else(|| std::env::var("SERVICE").ok())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn write(contents: &str) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(contents.as_bytes()).unwrap();
        file
    }

    #[test]
    fn loads_apps_and_resource_types_with_defaults() {
        let file =
            write(r#"{"apps":["App1","TestApp"],"resourceTypes":["Unknown","User","Order"]}"#);

        let config = AuditConfig::from_file(file.path()).unwrap();

        assert_eq!(config.apps, ["App1", "TestApp"]);
        assert!(config.is_app("TestApp"));
        assert!(!config.is_app("Nope"));
        assert!(config.is_resource_type("Order"));
        assert_eq!(config.ttl_seconds, DEFAULT_TTL_SECONDS);
        assert_eq!(config.service, None);
    }

    #[test]
    fn reads_optional_service_and_ttl() {
        let file =
            write(r#"{"apps":["A"],"resourceTypes":["T"],"service":"Orders","ttlSeconds":60}"#);

        let config = AuditConfig::from_file(file.path()).unwrap();

        assert_eq!(config.service(), Some("Orders".to_owned()));
        assert_eq!(config.ttl_seconds, 60);
    }

    #[test]
    fn rejects_empty_lists_and_bad_files() {
        let empty = write(r#"{"apps":[],"resourceTypes":["T"]}"#);
        assert!(matches!(
            AuditConfig::from_file(empty.path()),
            Err(ConfigError::Invalid { .. })
        ));

        let broken = write("{");
        assert!(matches!(
            AuditConfig::from_file(broken.path()),
            Err(ConfigError::Parse { .. })
        ));

        assert!(matches!(
            AuditConfig::from_file(Path::new("/nonexistent/audit-config.json")),
            Err(ConfigError::Read { .. })
        ));
    }
}
