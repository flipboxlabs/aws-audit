//! The apps, with their resource types, an audit stack accepts.
//!
//! The CDK `AuditConfigLayer` writes them to `/opt/audit-config.json` for Rust
//! Lambdas (the Node handlers import `audit-config.mjs` from the same layer).

use std::path::{Path, PathBuf};

use indexmap::IndexMap;
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
    /// Each app audits may target, with its resource types, in the config's order.
    pub apps: IndexMap<String, Vec<String>>,
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
    /// The config lists no apps, an app without resource types, or a name that
    /// isn't URL-safe.
    #[error("invalid audit config at {path}: {message}")]
    Invalid {
        /// The file.
        path: PathBuf,
        /// What's wrong.
        message: String,
    },
}

/// Whether `name` may name an app or resource type: letters, digits, `-` and `_`
/// only, as names are REST API path segments (`NAME_PATTERN` in the TypeScript SDK).
pub fn is_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

impl AuditConfig {
    /// A config accepting `apps`, each with its resource types, with the default
    /// TTL (`defineAuditConfig`). Unlike [`from_file`](Self::from_file), it
    /// doesn't check them; see [`problem`](Self::problem).
    pub fn new<A, T, I>(apps: impl IntoIterator<Item = (A, I)>) -> Self
    where
        A: Into<String>,
        T: Into<String>,
        I: IntoIterator<Item = T>,
    {
        AuditConfig {
            apps: apps
                .into_iter()
                .map(|(app, types)| (app.into(), types.into_iter().map(Into::into).collect()))
                .collect(),
            service: None,
            ttl_seconds: DEFAULT_TTL_SECONDS,
        }
    }

    /// Loads the config from `$AUDIT_CONFIG_PATH`, or [`DEFAULT_PATH`].
    pub fn load() -> Result<Self, ConfigError> {
        let path = std::env::var_os(PATH_VARIABLE)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_PATH));

        Self::from_file(&path)
    }

    /// Loads the config from a JSON file, refusing one with a
    /// [`problem`](Self::problem).
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

        match config.problem() {
            Some(message) => Err(ConfigError::Invalid {
                path: path.to_owned(),
                message,
            }),
            None => Ok(config),
        }
    }

    /// What's wrong with the config, if anything: it needs an app, each app a
    /// resource type (zod's `z.enum()` can't be built from an empty list), and
    /// every name must be URL-safe ([`is_name`]). The messages are
    /// `auditConfigProblem`'s in the TypeScript SDK.
    pub fn problem(&self) -> Option<String> {
        if self.apps.is_empty() {
            return Some("apps must list at least one app".to_owned());
        }
        for (app, types) in &self.apps {
            if !is_name(app) {
                return Some(format!(
                    "App \"{app}\" must hold only letters, digits, - and _"
                ));
            }
            if types.is_empty() {
                return Some(format!(
                    "App \"{app}\" must list at least one resource type"
                ));
            }
            if let Some(name) = types.iter().find(|name| !is_name(name)) {
                return Some(format!(
                    "Resource type \"{name}\" of app \"{app}\" must hold only letters, digits, - and _"
                ));
            }
        }
        None
    }

    /// Whether `app` is one of the configured apps.
    pub fn is_app(&self, app: &str) -> bool {
        self.apps.contains_key(app)
    }

    /// The resource types of `app`, if it's one of the configured apps.
    pub fn resource_types_of(&self, app: &str) -> Option<&[String]> {
        self.apps.get(app).map(Vec::as_slice)
    }

    /// Every app's resource types, each once, in the config's order.
    pub fn resource_types(&self) -> Vec<&str> {
        let mut types: Vec<&str> = Vec::new();
        for name in self.apps.values().flatten() {
            if !types.contains(&name.as_str()) {
                types.push(name);
            }
        }
        types
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
    fn loads_apps_with_their_resource_types_in_order() {
        let file = write(r#"{"apps":{"TestApp":["User","Order"],"App1":["Unknown","Order"]}}"#);

        let config = AuditConfig::from_file(file.path()).unwrap();

        assert_eq!(config.apps.keys().collect::<Vec<_>>(), ["TestApp", "App1"]);
        assert!(config.is_app("TestApp"));
        assert!(!config.is_app("Nope"));
        assert_eq!(
            config.resource_types_of("App1"),
            Some(&["Unknown".to_owned(), "Order".to_owned()][..])
        );
        assert_eq!(config.resource_types_of("Nope"), None);
        assert_eq!(config.resource_types(), ["User", "Order", "Unknown"]);
        assert_eq!(config.ttl_seconds, DEFAULT_TTL_SECONDS);
        assert_eq!(config.service, None);
    }

    #[test]
    fn reads_optional_service_and_ttl() {
        let file = write(r#"{"apps":{"A":["T"]},"service":"Orders","ttlSeconds":60}"#);

        let config = AuditConfig::from_file(file.path()).unwrap();

        assert_eq!(config.service(), Some("Orders".to_owned()));
        assert_eq!(config.ttl_seconds, 60);
    }

    #[test]
    fn refuses_empty_lists_and_names_that_arent_url_safe() {
        let message = |json: &str| match AuditConfig::from_file(write(json).path()) {
            Err(ConfigError::Invalid { message, .. }) => message,
            other => panic!("{other:?}"),
        };

        assert_eq!(message(r#"{"apps":{}}"#), "apps must list at least one app");
        assert_eq!(
            message(r#"{"apps":{"A":[]}}"#),
            "App \"A\" must list at least one resource type"
        );
        assert_eq!(
            message(r#"{"apps":{"Hub Spot":["Contact"]}}"#),
            "App \"Hub Spot\" must hold only letters, digits, - and _"
        );
        assert_eq!(
            message(r#"{"apps":{"HubSpot":["Contact",".."]}}"#),
            "Resource type \"..\" of app \"HubSpot\" must hold only letters, digits, - and _"
        );
        assert!(is_name("Hub_Spot-2"));
    }

    #[test]
    fn refuses_bad_files() {
        let flat = write(r#"{"apps":["A"],"resourceTypes":["T"]}"#);
        assert!(matches!(
            AuditConfig::from_file(flat.path()),
            Err(ConfigError::Parse { .. })
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
