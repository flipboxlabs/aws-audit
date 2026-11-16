//! What an upsert takes (`UpsertAuditSchema`), and what it stores
//! (`AuditStorageSchema`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::AuditConfig;
use crate::model::{
    Attempt, Context, EventBridgeEvent, ResourceReference, Status, Tier, Timestamp,
    parse_error_value,
};

/// An audit to create or update, as an app logs it.
///
/// Field order follows the TypeScript schema, so serialized events list fields the
/// same way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAudit {
    /// The audit's id; generated when absent. Retries with the same id are one audit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The operation's name.
    pub operation: String,
    /// The tenant, for multi-tenant apps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    /// Who sees the audit.
    #[serde(default)]
    pub tier: Tier,
    /// The outcome.
    #[serde(default = "default_status")]
    pub status: Status,
    /// The resource the operation acted on.
    pub target: ResourceReference,
    /// The resource that started the operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ResourceReference>,
    /// Extra metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// Other resources the operation affected; each with an id gets a copy of the
    /// audit, so it lists under that resource too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<Vec<ResourceReference>>,
    /// A human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The trace, `{id}:{stage}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
    /// The event that triggered the operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<EventBridgeEvent>,
    /// What went wrong, as a string (often a serialized `Error`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Whether the event can be re-sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerunable: Option<bool>,
    /// Earlier attempts. The store keeps its own list, so these are ignored there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<Vec<Attempt>>,
    /// When the audit was created; now when absent. Kept on later upserts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Timestamp>,
}

fn default_status() -> Status {
    Status::Success
}

/// One problem with an upsert, at a JSON path (zod's issue).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    /// What's wrong.
    pub message: String,
    /// Where: field names and array indexes.
    pub path: Vec<Value>,
}

/// An upsert naming an app or resource type the config doesn't list.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid audit: {}", .issues.iter().map(|issue| issue.message.as_str()).collect::<Vec<_>>().join("; "))]
pub struct InvalidUpsert {
    /// Every problem found.
    pub issues: Vec<Issue>,
}

impl UpsertAudit {
    /// Checks every resource reference against the configured apps and types, as
    /// `createTypedUpsertAuditSchema` does.
    pub fn validate(&self, config: &AuditConfig) -> Result<(), InvalidUpsert> {
        let mut issues = Vec::new();
        let mut check = |reference: &ResourceReference, path: Vec<Value>| {
            if !config.is_app(&reference.app) {
                issues.push(Issue {
                    message: format!("Invalid option: expected one of {}", options(&config.apps)),
                    path: [path.clone(), vec!["app".into()]].concat(),
                });
            }
            if !config.is_resource_type(&reference.resource_type) {
                issues.push(Issue {
                    message: format!(
                        "Invalid option: expected one of {}",
                        options(&config.resource_types)
                    ),
                    path: [path, vec!["type".into()]].concat(),
                });
            }
        };

        check(&self.target, vec!["target".into()]);
        if let Some(source) = &self.source {
            check(source, vec!["source".into()]);
        }
        for (index, resource) in self.resources.iter().flatten().enumerate() {
            check(resource, vec!["resources".into(), index.into()]);
        }

        if issues.is_empty() {
            Ok(())
        } else {
            Err(InvalidUpsert { issues })
        }
    }
}

fn options(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join("|")
}

/// An audit as stored (`AuditStorageSchema`), in the schema's field order: the
/// upsert's `UpdateExpression` sets fields in this order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAudit {
    /// The audit's id.
    pub id: String,
    /// The tenant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    /// The outcome.
    pub status: Status,
    /// Who sees the audit.
    pub tier: Tier,
    /// The resource the operation acted on.
    pub target: ResourceReference,
    /// The resource that started the operation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ResourceReference>,
    /// Extra metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// The operation's name.
    pub operation: String,
    /// A human-readable description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Whether the event can be re-sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rerunable: Option<bool>,
    /// The trace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
    /// The triggering event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<EventBridgeEvent>,
    /// What went wrong: a string, or the object a JSON-object string held.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    /// Attempts, when given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<Vec<Attempt>>,
    /// When the audit last changed.
    pub updated_at: Timestamp,
    /// When the audit was created.
    pub created_at: Timestamp,
}

impl StoredAudit {
    /// The stored form of `audit` with id `id`, upserted at `now`.
    pub fn new(audit: &UpsertAudit, id: String, now: &Timestamp) -> Self {
        StoredAudit {
            id,
            tenant_id: audit.tenant_id.clone(),
            status: audit.status,
            tier: audit.tier,
            target: audit.target.clone(),
            source: audit.source.clone(),
            context: audit.context.clone(),
            operation: audit.operation.clone(),
            message: audit.message.clone(),
            rerunable: audit.rerunable,
            trace: audit.trace.clone(),
            event: audit.event.clone(),
            error: audit.error.clone().map(parse_error_value),
            attempts: audit.attempts.clone(),
            updated_at: now.clone(),
            created_at: audit.created_at.clone().unwrap_or_else(|| now.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn config() -> AuditConfig {
        serde_json::from_value(
            json!({ "apps": ["App1", "TestApp"], "resourceTypes": ["Unknown", "User", "Order"] }),
        )
        .unwrap()
    }

    #[test]
    fn applies_defaults() {
        let audit: UpsertAudit = serde_json::from_value(json!({
            "operation": "createOrder",
            "target": { "app": "App1", "type": "Order" },
        }))
        .unwrap();

        assert_eq!(audit.status, Status::Success);
        assert_eq!(audit.tier, Tier::INFO);
    }

    #[test]
    fn reports_unknown_apps_and_types_at_their_paths() {
        let audit: UpsertAudit = serde_json::from_value(json!({
            "operation": "createOrder",
            "target": { "app": "Nope", "type": "Order" },
            "resources": [{ "app": "App1", "type": "User" }, { "app": "App1", "type": "Nope" }],
        }))
        .unwrap();

        let issues = audit.validate(&config()).unwrap_err().issues;

        let paths: Vec<_> = issues.iter().map(|issue| json!(issue.path)).collect();
        assert_eq!(
            paths,
            [json!(["target", "app"]), json!(["resources", 1, "type"])]
        );
        assert_eq!(
            issues[0].message,
            r#"Invalid option: expected one of "App1"|"TestApp""#
        );
    }

    #[test]
    fn stores_fields_in_schema_order_and_parses_object_errors() {
        let audit: UpsertAudit = serde_json::from_value(json!({
            "id": "audit-1",
            "operation": "createOrder",
            "target": { "app": "App1", "type": "Order" },
            "error": r#"{"name":"Error"}"#,
            "tenantId": "tenant-1",
        }))
        .unwrap();
        let now = Timestamp::try_from("2026-01-02T03:04:05.678Z".to_owned()).unwrap();

        let stored =
            serde_json::to_value(StoredAudit::new(&audit, "audit-1".into(), &now)).unwrap();

        let keys: Vec<_> = stored
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "id",
                "tenantId",
                "status",
                "tier",
                "target",
                "operation",
                "error",
                "updatedAt",
                "createdAt"
            ]
        );
        assert_eq!(stored["error"], json!({ "name": "Error" }));
    }
}
