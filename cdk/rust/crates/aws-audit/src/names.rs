//! AWS resource names (`DynamoDB.Table.Name` and `EventBridge.Bus.Name` in the
//! TypeScript SDK): the table is `{ENVIRONMENT}-{SERVICE}-Audit-v2` and the event
//! bus `{ENVIRONMENT}-{SERVICE}-Audit`, each without `-{SERVICE}` when there's no
//! service.

/// `ENVIRONMENT` isn't set.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("ENVIRONMENT must be set to name the audit table and event bus")]
pub struct MissingEnvironment;

/// The audit table's and event bus's names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceNames {
    /// The DynamoDB table.
    pub table: String,
    /// The EventBridge bus.
    pub event_bus: String,
}

/// The names for an environment and service.
pub fn resource_names(environment: &str, service: Option<&str>) -> ResourceNames {
    let name = |suffix: &str| {
        [
            Some(environment.to_uppercase().as_str()),
            service,
            Some(suffix),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
    };

    ResourceNames {
        table: name("Audit-v2"),
        event_bus: name("Audit"),
    }
}

/// The names from the `ENVIRONMENT` and `SERVICE` environment variables.
///
/// The TypeScript SDK names them `UNDEFINED-…` when `ENVIRONMENT` is missing;
/// this refuses instead.
pub fn resource_names_from_env() -> Result<ResourceNames, MissingEnvironment> {
    let environment = std::env::var("ENVIRONMENT")
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or(MissingEnvironment)?;
    let service = std::env::var("SERVICE").ok();

    Ok(resource_names(&environment, service.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_environment_service_and_suffix() {
        assert_eq!(
            resource_names("test", Some("Contract")),
            ResourceNames {
                table: "TEST-Contract-Audit-v2".to_owned(),
                event_bus: "TEST-Contract-Audit".to_owned(),
            }
        );
        assert_eq!(resource_names("prod", None).table, "PROD-Audit-v2");
        assert_eq!(resource_names("prod", Some("")).event_bus, "PROD-Audit");
    }
}
