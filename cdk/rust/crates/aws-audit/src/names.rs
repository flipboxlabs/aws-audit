//! AWS resource names (`DynamoDB.Table.Name` and `EventBridge.Bus.Name` in the
//! TypeScript SDK). The table and the event bus share one name:
//! `{ENVIRONMENT}-{SERVICE}-Audit`, or `{ENVIRONMENT}-Audit` without a service.

/// `ENVIRONMENT` isn't set.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("ENVIRONMENT must be set to name the audit table and event bus")]
pub struct MissingEnvironment;

/// The name the audit table and event bus share.
pub fn resource_name(environment: &str, service: Option<&str>) -> String {
    [
        Some(environment.to_uppercase().as_str()),
        service,
        Some("Audit"),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("-")
}

/// The name from the `ENVIRONMENT` and `SERVICE` environment variables.
///
/// The TypeScript SDK names the table `UNDEFINED-…-Audit` when `ENVIRONMENT` is
/// missing; this refuses instead.
pub fn resource_name_from_env() -> Result<String, MissingEnvironment> {
    let environment = std::env::var("ENVIRONMENT")
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or(MissingEnvironment)?;
    let service = std::env::var("SERVICE").ok();

    Ok(resource_name(&environment, service.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_environment_service_and_audit() {
        assert_eq!(
            resource_name("test", Some("Contract")),
            "TEST-Contract-Audit"
        );
        assert_eq!(resource_name("prod", None), "PROD-Audit");
        assert_eq!(resource_name("prod", Some("")), "PROD-Audit");
    }
}
