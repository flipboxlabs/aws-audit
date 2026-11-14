//! Key formats: how an audit's table and index keys are built from its fields, and
//! how a trace is read back from them (`construct*Key*` and `resolveTrace` in the
//! TypeScript repository).

use serde_json::{Map, Value};

use crate::model::ResourceId;
use crate::table::{TTL_ATTRIBUTE, keys};
use crate::upsert::StoredAudit;

/// `{tenantId}#{base}`, or `base` without a tenant.
pub fn partition(tenant_id: Option<&str>, base: &str) -> String {
    match tenant_id {
        Some(tenant) if !tenant.is_empty() => format!("{tenant}#{base}"),
        _ => base.to_owned(),
    }
}

/// The table key: `PK` `[{tenantId}#]{app}.{type}`, `SK` the id.
pub fn primary_key(
    tenant_id: Option<&str>,
    app: &str,
    resource_type: &str,
    id: &str,
) -> Map<String, Value> {
    Map::from_iter([
        (
            keys::PARTITION_KEY.to_owned(),
            Value::String(partition(tenant_id, &format!("{app}.{resource_type}"))),
        ),
        (keys::SORT_KEY.to_owned(), Value::String(id.to_owned())),
    ])
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

/// A trace's id and stage: `batch:2026:3` is `("batch:2026", 3)`. The stage is the
/// integer after the last colon; without one, the whole trace is the id at stage 0.
pub fn trace_parts(trace: &str) -> (&str, u64) {
    match trace.rsplit_once(':') {
        Some((id, stage)) if !stage.is_empty() && stage.bytes().all(|b| b.is_ascii_digit()) => {
            match stage.parse() {
                Ok(stage) => (id, stage),
                Err(_) => (trace, 0),
            }
        }
        _ => (trace, 0),
    }
}

/// The index keys and TTL an audit is written with, in the order the upsert sets
/// them. `now_millis` is the write time in epoch milliseconds.
pub fn secondary_keys(
    audit: &StoredAudit,
    now_millis: i64,
    ttl_seconds: u64,
) -> Vec<(String, Value)> {
    let tenant = audit.tenant_id.as_deref();
    let target = &audit.target;
    let mut fields = Vec::with_capacity(8);

    // Tier, then epoch milliseconds: a number sorting by tier, then write time
    let lsi = format!("{}{now_millis}", audit.tier.get());
    fields.push((
        keys::LSI1_N_SORT_KEY.to_owned(),
        lsi.parse::<u64>().map_or(Value::Null, Value::from),
    ));

    let resource = format!("{}.{}", target.app, target.resource_type);
    let resource = match &target.id {
        id if has_resource_id(id.as_ref()) => {
            format!(
                "{resource}#{}",
                id.as_ref().map(ResourceId::to_key).unwrap_or_default()
            )
        }
        _ => resource,
    };
    fields.push((
        keys::GSI1_SS_PARTITION_KEY.to_owned(),
        Value::String(partition(tenant, &resource)),
    ));
    fields.push((
        keys::GSI1_SS_SORT_KEY.to_owned(),
        Value::String(audit.id.clone()),
    ));

    if let Some(trace) = audit.trace.as_deref().filter(|trace| !trace.is_empty()) {
        let (id, stage) = trace_parts(trace);
        fields.push((
            keys::GSI1_SN_PARTITION_KEY.to_owned(),
            Value::String(partition(tenant, id)),
        ));
        fields.push((keys::GSI1_SN_SORT_KEY.to_owned(), Value::from(stage)));
    }

    fields.push((
        keys::GSI2_SS_PARTITION_KEY.to_owned(),
        Value::String(partition(tenant, audit.status.as_str())),
    ));
    fields.push((
        keys::GSI2_SS_SORT_KEY.to_owned(),
        Value::String(format!("{}#{}", audit.created_at, audit.id)),
    ));

    let now_seconds = now_millis.div_euclid(1000);
    fields.push((
        TTL_ATTRIBUTE.to_owned(),
        Value::from(now_seconds.saturating_add_unsigned(ttl_seconds)),
    ));

    fields
}

/// Sets an item's `trace`. A stored `trace` string is kept; otherwise it's rebuilt
/// from the trace index keys (`{id}` at stage 0, else `{id}:{stage}`), without the
/// tenant prefix. A non-string `trace` is dropped.
pub fn resolve_trace(item: &mut Map<String, Value>, tenant_id: Option<&str>) {
    match item.get("trace") {
        Some(Value::String(_)) => return,
        Some(_) => {
            item.shift_remove("trace");
        }
        None => {}
    }

    let (Some(Value::String(partition)), Some(stage)) = (
        item.get(keys::GSI1_SN_PARTITION_KEY),
        item.get(keys::GSI1_SN_SORT_KEY),
    ) else {
        return;
    };

    let tenant = item
        .get("tenantId")
        .and_then(Value::as_str)
        .or(tenant_id)
        .filter(|tenant| !tenant.is_empty());
    let id = tenant
        .and_then(|tenant| partition.strip_prefix(&format!("{tenant}#")))
        .unwrap_or(partition);

    let stage = match stage {
        Value::Number(number) => crate::js::number_to_string(number),
        Value::String(text) => text.clone(),
        _ => return,
    };
    let trace = if stage == "0" {
        id.to_owned()
    } else {
        format!("{id}:{stage}")
    };

    item.insert("trace".to_owned(), Value::String(trace));
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn splits_traces_on_the_last_colon() {
        assert_eq!(trace_parts("abc-123:5"), ("abc-123", 5));
        assert_eq!(trace_parts("abc-123"), ("abc-123", 0));
        assert_eq!(trace_parts("batch:2026:3"), ("batch:2026", 3));
        for trace in ["batch:a", "batch:", "batch:-1", "batch:1.5", "batch:5x"] {
            assert_eq!(trace_parts(trace), (trace, 0), "{trace}");
        }
    }

    #[test]
    fn counts_zero_as_a_resource_id() {
        assert!(has_resource_id(Some(&ResourceId::Number(0.into()))));
        assert!(!has_resource_id(Some(&ResourceId::String(String::new()))));
        assert!(!has_resource_id(None));
    }

    #[test]
    fn rebuilds_the_trace_without_the_tenant() {
        let mut item = json!({ "GSI1_SN_PK": "tenant-1#trace-1", "GSI1_SN_SK": 2 });
        resolve_trace(item.as_object_mut().unwrap(), Some("tenant-1"));
        assert_eq!(item["trace"], "trace-1:2");

        let mut item = json!({ "GSI1_SN_PK": "trace-1", "GSI1_SN_SK": 0 });
        resolve_trace(item.as_object_mut().unwrap(), None);
        assert_eq!(item["trace"], "trace-1");

        let mut item = json!({ "trace": "kept:1", "GSI1_SN_PK": "other", "GSI1_SN_SK": 3 });
        resolve_trace(item.as_object_mut().unwrap(), None);
        assert_eq!(item["trace"], "kept:1");
    }
}
