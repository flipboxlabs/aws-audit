//! Key formats: how an audit's table key, index attributes and `scopes` are built
//! from its fields (`constructPrimaryKey`, `constructIndexAttributes`,
//! `resourceScopes` and `filterScope` in the TypeScript repository).

use serde_json::{Map, Value};

use crate::model::{ResourceId, ResourceReference};
use crate::table::{NO_TENANT, attributes, keys, sort_keys};
use crate::trace::trace_parts;

/// `{tenantId}#{base}`, or `base` without a tenant.
pub fn partition(tenant_id: Option<&str>, base: &str) -> String {
    match tenant_id {
        Some(tenant) if !tenant.is_empty() => format!("{tenant}#{base}"),
        _ => base.to_owned(),
    }
}

/// The tenant part of every index key: the tenant, or [`NO_TENANT`].
pub fn tenant_key(tenant_id: Option<&str>) -> &str {
    tenant_id
        .filter(|tenant| !tenant.is_empty())
        .unwrap_or(NO_TENANT)
}

/// An audit's table key: `PK` `[{tenantId}#]{app}.{type}#{id}`, `SK` `audit`.
pub fn primary_key(
    tenant_id: Option<&str>,
    app: &str,
    resource_type: &str,
    id: &str,
) -> Map<String, Value> {
    Map::from_iter([
        (
            keys::PARTITION_KEY.to_owned(),
            Value::String(partition(tenant_id, &format!("{app}.{resource_type}#{id}"))),
        ),
        (
            keys::SORT_KEY.to_owned(),
            Value::String(sort_keys::AUDIT.to_owned()),
        ),
    ])
}

/// The sort key of an audit's copy under a related resource:
/// `related#{app}.{type}#{id}`.
pub fn related_sort_key(resource: &ResourceReference) -> String {
    format!(
        "{}{}.{}#{}",
        sort_keys::RELATED_PREFIX,
        resource.app,
        resource.resource_type,
        resource
            .id
            .as_ref()
            .map(ResourceId::to_key)
            .unwrap_or_default()
    )
}

/// Whether a resource has an id. A numeric `0` does; only a missing or empty one
/// doesn't.
pub fn has_resource_id(id: Option<&ResourceId>) -> bool {
    match id {
        None => false,
        Some(ResourceId::String(id)) => !id.is_empty(),
        Some(ResourceId::Number(_)) => true,
    }
}

/// The top-level attributes an item's index keys are built from, in the order the
/// upsert sets them.
///
/// The resource id is stored as a string, so numeric and string ids list together.
/// Only audits (`kind` `audit`) get the trace attributes, which keeps copies out of
/// `ByTrace`.
pub fn index_attributes(
    tenant_id: Option<&str>,
    target: &ResourceReference,
    trace: Option<&str>,
    kind: &str,
) -> Vec<(String, Value)> {
    let mut fields = vec![
        (
            attributes::TENANT_KEY.to_owned(),
            Value::String(tenant_key(tenant_id).to_owned()),
        ),
        (
            attributes::APP.to_owned(),
            Value::String(target.app.clone()),
        ),
        (
            attributes::RESOURCE_TYPE.to_owned(),
            Value::String(target.resource_type.clone()),
        ),
    ];

    if let Some(id) = target.id.as_ref().filter(|id| has_resource_id(Some(id))) {
        fields.push((
            attributes::RESOURCE_ID.to_owned(),
            Value::String(id.to_key()),
        ));
    }

    fields.push((attributes::KIND.to_owned(), Value::String(kind.to_owned())));

    let trace = trace.filter(|trace| kind == crate::table::kinds::AUDIT && !trace.is_empty());
    if let Some(trace) = trace {
        let (id, stage) = trace_parts(trace);
        fields.push((
            attributes::TRACE_ID.to_owned(),
            Value::String(id.to_owned()),
        ));
        fields.push((attributes::TRACE_STAGE.to_owned(), Value::from(stage)));
    }

    fields
}

/// What an audit's `scopes` attribute holds for one of its resources: everything a
/// resource filter can name it by.
pub fn resource_scopes(resource: &ResourceReference) -> Vec<String> {
    let app = &resource.app;
    let resource_type = &resource.resource_type;
    let mut scopes = vec![
        app.clone(),
        format!("{app}.{resource_type}"),
        format!("*.{resource_type}"),
    ];
    if let Some(id) = resource.id.as_ref().filter(|id| has_resource_id(Some(id))) {
        scopes.push(format!("{app}.{resource_type}#{}", id.to_key()));
    }
    scopes
}

/// The `scopes` of an audit: its target's, then each related resource's, each once,
/// in that order.
pub fn audit_scopes<'a>(
    target: &'a ResourceReference,
    resources: impl IntoIterator<Item = &'a ResourceReference>,
) -> Vec<String> {
    let mut scopes: Vec<String> = Vec::new();
    for scope in std::iter::once(target)
        .chain(resources)
        .flat_map(resource_scopes)
    {
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    scopes
}

/// A resource id filter without its app and resource type.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("A resource id filter needs an app and a resource type")]
pub struct IncompleteResourceFilter;

/// The `scopes` value a resource filter matches, if it filters at all.
pub fn filter_scope(
    app: Option<&str>,
    resource_type: Option<&str>,
    resource_id: Option<&str>,
) -> Result<Option<String>, IncompleteResourceFilter> {
    let app = app.filter(|app| !app.is_empty());
    let resource_type = resource_type.filter(|resource_type| !resource_type.is_empty());

    Ok(
        match (app, resource_type, resource_id.filter(|id| !id.is_empty())) {
            (Some(app), Some(resource_type), Some(id)) => {
                Some(format!("{app}.{resource_type}#{id}"))
            }
            (_, _, Some(_)) => return Err(IncompleteResourceFilter),
            (Some(app), Some(resource_type), None) => Some(format!("{app}.{resource_type}")),
            (Some(app), None, None) => Some(app.to_owned()),
            (None, Some(resource_type), None) => Some(format!("*.{resource_type}")),
            (None, None, None) => None,
        },
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn resource(value: Value) -> ResourceReference {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn counts_zero_as_a_resource_id() {
        assert!(has_resource_id(Some(&ResourceId::Number(0.into()))));
        assert!(!has_resource_id(Some(&ResourceId::String(String::new()))));
        assert!(!has_resource_id(None));
    }

    #[test]
    fn keys_audits_by_their_id() {
        assert_eq!(
            Value::Object(primary_key(Some("tenant-1"), "App1", "Order", "audit-1")),
            json!({ "PK": "tenant-1#App1.Order#audit-1", "SK": "audit" })
        );
    }

    #[test]
    fn leaves_trace_attributes_off_copies() {
        let target = resource(json!({ "app": "App1", "type": "Order", "id": 0 }));

        let audit = index_attributes(None, &target, Some("trace-1:2"), "audit");
        let copy = index_attributes(Some("tenant-1"), &target, Some("trace-1:2"), "related");

        assert_eq!(
            Value::Object(audit.into_iter().collect()),
            json!({
                "tenantKey": "-", "app": "App1", "resourceType": "Order", "resourceId": "0",
                "kind": "audit", "traceId": "trace-1", "traceStage": 2,
            })
        );
        assert_eq!(
            Value::Object(copy.into_iter().collect()),
            json!({
                "tenantKey": "tenant-1", "app": "App1", "resourceType": "Order",
                "resourceId": "0", "kind": "related",
            })
        );
    }

    #[test]
    fn scopes_each_resource_once() {
        let target = resource(json!({ "app": "App1", "type": "Order", "id": "order-1" }));
        let resources = [
            resource(json!({ "app": "App1", "type": "User" })),
            resource(json!({ "app": "App1", "type": "Order", "id": "order-1" })),
        ];

        assert_eq!(
            audit_scopes(&target, &resources),
            [
                "App1",
                "App1.Order",
                "*.Order",
                "App1.Order#order-1",
                "App1.User",
                "*.User"
            ]
        );
    }

    #[test]
    fn matches_the_narrowest_scope_a_filter_names() {
        let scope = |app, resource_type, id| filter_scope(app, resource_type, id);

        assert_eq!(scope(None, None, None), Ok(None));
        assert_eq!(scope(Some("App1"), None, None), Ok(Some("App1".into())));
        assert_eq!(scope(None, Some("Order"), None), Ok(Some("*.Order".into())));
        assert_eq!(
            scope(Some("App1"), Some("Order"), None),
            Ok(Some("App1.Order".into()))
        );
        assert_eq!(
            scope(Some("App1"), Some("Order"), Some("order-1")),
            Ok(Some("App1.Order#order-1".into()))
        );
        assert_eq!(
            scope(Some("App1"), None, Some("order-1")),
            Err(IncompleteResourceFilter)
        );
    }
}
