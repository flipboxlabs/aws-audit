//! Key formats: how an audit's table key, index attributes and `scopes` are built
//! from its fields (`constructPrimaryKey`, `constructIndexAttributes`,
//! `resourceScopes` and `filterScope` in the TypeScript repository).

use serde_json::{Map, Value};

use crate::model::{ResourceId, ResourceReference};
use crate::table::{NO_TENANT, attributes, keys, sort_keys};
use crate::trace::trace_parts;

/// Joins the parts of a key or `scopes` value with `#`, escaping `%`, `#` and `*`
/// in each (as `%25`, `%23` and `%2A`), so distinct parts never join to the same
/// value: a tenant and an audit id holding a `#` would otherwise share a partition
/// with another tenant's audit (`joinKey` in the TypeScript repository).
pub fn join_key<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    let mut key = String::new();
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            key.push('#');
        }
        for char in part.chars() {
            match char {
                '%' => key.push_str("%25"),
                '#' => key.push_str("%23"),
                '*' => key.push_str("%2A"),
                char => key.push(char),
            }
        }
    }
    key
}

/// The tenant id [`NO_TENANT`], the key of audits without a tenant, which a listing
/// would otherwise return as that tenant's (`ReservedTenantError` in the TypeScript
/// SDK).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Tenant id \"{NO_TENANT}\" is reserved for audits without a tenant")]
pub struct ReservedTenant;

/// The tenant part of every index key: the tenant, or [`NO_TENANT`] without one.
pub fn tenant_key(tenant_id: Option<&str>) -> Result<&str, ReservedTenant> {
    match tenant_id.filter(|tenant| !tenant.is_empty()) {
        Some(NO_TENANT) => Err(ReservedTenant),
        tenant => Ok(tenant.unwrap_or(NO_TENANT)),
    }
}

/// An audit's table key: `PK` `{tenantKey}#{app}#{type}#{id}`, each part escaped
/// by [`join_key`], with [`NO_TENANT`] as the tenant of an audit without one; `SK`
/// `audit`.
pub fn primary_key(
    tenant_id: Option<&str>,
    app: &str,
    resource_type: &str,
    id: &str,
) -> Result<Map<String, Value>, ReservedTenant> {
    Ok(Map::from_iter([
        (
            keys::PARTITION_KEY.to_owned(),
            Value::String(join_key([tenant_key(tenant_id)?, app, resource_type, id])),
        ),
        (
            keys::SORT_KEY.to_owned(),
            Value::String(sort_keys::AUDIT.to_owned()),
        ),
    ]))
}

/// The sort key of an audit's copy under a related resource:
/// `related#{app}#{type}#{id}`, each part escaped by [`join_key`].
pub fn related_sort_key(resource: &ResourceReference) -> String {
    let id = resource
        .id
        .as_ref()
        .map(ResourceId::to_key)
        .unwrap_or_default();
    format!(
        "{}{}",
        sort_keys::RELATED_PREFIX,
        join_key([resource.app.as_str(), &resource.resource_type, &id])
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
/// Only audits get `kind` and the trace attributes, which keeps copies out of
/// `ByStatus` and `ByTrace`.
pub fn index_attributes(
    tenant_id: Option<&str>,
    target: &ResourceReference,
    trace: Option<&str>,
    kind: &str,
) -> Result<Vec<(String, Value)>, ReservedTenant> {
    let mut fields = vec![
        (
            attributes::TENANT_KEY.to_owned(),
            Value::String(tenant_key(tenant_id)?.to_owned()),
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

    let audit = kind == crate::table::kinds::AUDIT;
    if audit {
        fields.push((attributes::KIND.to_owned(), Value::String(kind.to_owned())));
    }

    let trace = trace.filter(|trace| audit && !trace.is_empty());
    if let Some(trace) = trace {
        let (id, stage) = trace_parts(trace);
        fields.push((
            attributes::TRACE_ID.to_owned(),
            Value::String(id.to_owned()),
        ));
        fields.push((attributes::TRACE_STAGE.to_owned(), Value::from(stage)));
    }

    Ok(fields)
}

/// What an audit's `scopes` attribute holds for one of its resources: everything a
/// resource filter can name it by (`{app}`, `{app}#{type}`, `*#{type}` and
/// `{app}#{type}#{id}`, each part escaped by [`join_key`]).
pub fn resource_scopes(resource: &ResourceReference) -> Vec<String> {
    let app = resource.app.as_str();
    let resource_type = resource.resource_type.as_str();
    let mut scopes = vec![
        join_key([app]),
        join_key([app, resource_type]),
        format!("*#{}", join_key([resource_type])),
    ];
    if let Some(id) = resource.id.as_ref().filter(|id| has_resource_id(Some(id))) {
        scopes.push(join_key([app, resource_type, &id.to_key()]));
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
            (Some(app), Some(resource_type), Some(id)) => Some(join_key([app, resource_type, id])),
            (_, _, Some(_)) => return Err(IncompleteResourceFilter),
            (Some(app), Some(resource_type), None) => Some(join_key([app, resource_type])),
            (Some(app), None, None) => Some(join_key([app])),
            (None, Some(resource_type), None) => Some(format!("*#{}", join_key([resource_type]))),
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
            primary_key(Some("tenant-1"), "App1", "Order", "audit-1").map(Value::Object),
            Ok(json!({ "PK": "tenant-1#App1#Order#audit-1", "SK": "audit" }))
        );
        assert_eq!(
            primary_key(None, "App1", "Order", "audit-1").map(Value::Object),
            Ok(json!({ "PK": "-#App1#Order#audit-1", "SK": "audit" }))
        );
        assert_eq!(
            primary_key(Some("-"), "App1", "Order", "audit-1"),
            Err(ReservedTenant)
        );
    }

    #[test]
    fn escapes_each_part_so_distinct_audits_never_share_a_key() {
        let key =
            |tenant, id| primary_key(Some(tenant), "App1", "Order", id).unwrap()["PK"].clone();

        assert_eq!(
            key("t1", "a#App1#Order#b"),
            json!("t1#App1#Order#a%23App1%23Order%23b")
        );
        assert_ne!(key("t1", "a#App1#Order#b"), key("t1#App1#Order#a", "b"));
        assert_eq!(join_key(["100%", "*"]), "100%25#%2A");
        assert_eq!(
            related_sort_key(&resource(
                json!({ "app": "App1", "type": "Order", "id": "a#b" })
            )),
            "related#App1#Order#a%23b"
        );
    }

    #[test]
    fn reserves_the_no_tenant_key() {
        assert_eq!(tenant_key(None), Ok("-"));
        assert_eq!(tenant_key(Some("")), Ok("-"));
        assert_eq!(tenant_key(Some("tenant-1")), Ok("tenant-1"));
        assert_eq!(tenant_key(Some("-")), Err(ReservedTenant));
    }

    #[test]
    fn leaves_kind_and_trace_attributes_off_copies() {
        let target = resource(json!({ "app": "App1", "type": "Order", "id": 0 }));

        let audit = index_attributes(None, &target, Some("trace-1:2"), "audit").unwrap();
        let copy =
            index_attributes(Some("tenant-1"), &target, Some("trace-1:2"), "related").unwrap();

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
                "resourceId": "0",
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
                "App1#Order",
                "*#Order",
                "App1#Order#order-1",
                "App1#User",
                "*#User"
            ]
        );
    }

    #[test]
    fn matches_the_narrowest_scope_a_filter_names() {
        let scope = |app, resource_type, id| filter_scope(app, resource_type, id);

        assert_eq!(scope(None, None, None), Ok(None));
        assert_eq!(scope(Some("App1"), None, None), Ok(Some("App1".into())));
        assert_eq!(scope(None, Some("Order"), None), Ok(Some("*#Order".into())));
        assert_eq!(scope(Some("*"), None, None), Ok(Some("%2A".into())));
        assert_eq!(
            scope(Some("App1"), Some("Order"), None),
            Ok(Some("App1#Order".into()))
        );
        assert_eq!(
            scope(Some("App1"), Some("Order"), Some("order-1")),
            Ok(Some("App1#Order#order-1".into()))
        );
        assert_eq!(
            scope(Some("App1"), None, Some("order-1")),
            Err(IncompleteResourceFilter)
        );
    }
}
