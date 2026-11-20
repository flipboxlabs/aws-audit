//! The audit a rerun's event reruns (`RerunOf` in the TypeScript SDK).
//!
//! The rerun Lambda sends an audit's event again with its `detail` as stored, and
//! names the audit in one of the entry's `Resources`: [`RESOURCE_PREFIX`] followed
//! by [`RerunOf`] as JSON. A target that gets the whole event (an SQS queue without
//! an input transformer) receives it in `resources`. A rerun fires every rule the
//! event matches, so only the handler whose audit [`matches`](RerunOf::matches) the
//! original's logs its outcome under the original's id, as an attempt of it.

use serde::{Deserialize, Serialize};

use crate::model::{Audit, ResourceId, ResourceReference};

/// What starts the `Resources` entry naming the audit a rerun reruns.
pub const RESOURCE_PREFIX: &str = "aws-audit:rerun:";

/// The longest `Resources` entry `PutEvents` takes.
pub const RESOURCE_MAX_LENGTH: usize = 2048;

/// The audit a rerun's event reruns: its id, and what tells its handler's audits
/// from those of the event's other rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerunOf {
    /// The audit's id.
    pub id: String,
    /// The audit's tenant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    /// The audit's target.
    pub target: ResourceReference,
    /// The audit's operation.
    pub operation: String,
}

impl RerunOf {
    /// A rerun of `audit`.
    pub fn of(audit: &Audit) -> Self {
        RerunOf {
            id: audit.id.clone(),
            tenant_id: audit.tenant_id.clone().filter(|tenant| !tenant.is_empty()),
            target: audit.target.clone(),
            operation: audit.operation.clone(),
        }
    }

    /// The `Resources` entry naming the audit, or none when it's longer than
    /// `PutEvents` takes (a long resource id).
    pub fn to_resource(&self) -> Option<String> {
        let resource = format!(
            "{RESOURCE_PREFIX}{}",
            serde_json::to_string(self).expect("a rerun serializes")
        );
        (resource.len() <= RESOURCE_MAX_LENGTH).then_some(resource)
    }

    /// The audit a `Resources` entry names, if it's one.
    pub fn from_resource(resource: &str) -> Option<Self> {
        serde_json::from_str(resource.strip_prefix(RESOURCE_PREFIX)?).ok()
    }

    /// The audit the first entry naming one names.
    pub fn from_resources<'a>(resources: impl IntoIterator<Item = &'a str>) -> Option<Self> {
        resources.into_iter().find_map(Self::from_resource)
    }

    /// Whether an audit of `operation` on `target` for `tenant_id` is the rerun
    /// audit's: an empty tenant or resource id is none, and ids compare as keys,
    /// so `1` is `"1"`.
    pub fn matches(
        &self,
        tenant_id: Option<&str>,
        target: &ResourceReference,
        operation: &str,
    ) -> bool {
        fn tenant(tenant_id: Option<&str>) -> Option<&str> {
            tenant_id.filter(|tenant| !tenant.is_empty())
        }
        fn id(reference: &ResourceReference) -> Option<String> {
            reference
                .id
                .as_ref()
                .map(ResourceId::to_key)
                .filter(|id| !id.is_empty())
        }

        self.operation == operation
            && tenant(self.tenant_id.as_deref()) == tenant(tenant_id)
            && self.target.app == target.app
            && self.target.resource_type == target.resource_type
            && id(&self.target) == id(target)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn rerun() -> RerunOf {
        RerunOf {
            id: "audit-1".to_owned(),
            tenant_id: None,
            target: ResourceReference::new("App1", "Order").with_id("order-1"),
            operation: "createOrder".to_owned(),
        }
    }

    #[test]
    fn names_the_audit_in_a_resource() {
        let resource = rerun().to_resource().unwrap();

        assert_eq!(
            resource,
            r#"aws-audit:rerun:{"id":"audit-1","target":{"app":"App1","id":"order-1","type":"Order"},"operation":"createOrder"}"#
        );
        assert_eq!(RerunOf::from_resource(&resource), Some(rerun()));
        assert_eq!(
            RerunOf::from_resources(["arn:aws:s3:::bucket", resource.as_str()]),
            Some(rerun())
        );
        assert_eq!(RerunOf::from_resource("arn:aws:s3:::bucket"), None);
        assert_eq!(RerunOf::from_resource("aws-audit:rerun:{}"), None);
    }

    #[test]
    fn names_none_in_a_resource_put_events_refuses() {
        let mut long = rerun();
        long.target = long.target.with_id("x".repeat(RESOURCE_MAX_LENGTH));

        assert_eq!(long.to_resource(), None);
    }

    #[test]
    fn matches_only_the_audits_tenant_target_and_operation() {
        let rerun = rerun();
        let target = ResourceReference::new("App1", "Order").with_id("order-1");

        assert!(rerun.matches(None, &target, "createOrder"));
        assert!(rerun.matches(Some(""), &target, "createOrder"));
        assert!(!rerun.matches(Some("tenant-1"), &target, "createOrder"));
        assert!(!rerun.matches(None, &target, "summarize"));
        assert!(!rerun.matches(
            None,
            &ResourceReference::new("App1", "User").with_id("order-1"),
            "createOrder"
        ));
        assert!(!rerun.matches(
            None,
            &ResourceReference::new("App1", "Order").with_id("order-2"),
            "createOrder"
        ));
        assert!(!rerun.matches(
            None,
            &ResourceReference::new("App1", "Order"),
            "createOrder"
        ));

        let numbered: RerunOf = serde_json::from_value(json!({
            "id": "audit-1",
            "tenantId": "tenant-1",
            "target": { "app": "App1", "type": "Order", "id": 1 },
            "operation": "createOrder",
        }))
        .unwrap();
        assert!(numbered.matches(
            Some("tenant-1"),
            &ResourceReference::new("App1", "Order").with_id("1"),
            "createOrder"
        ));
    }
}
