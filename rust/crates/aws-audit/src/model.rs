//! The audit model, as the TypeScript SDK's zod schemas define it
//! (`sdk/src/schema/common.ts`, `audit.ts`, `model.ts`).
//!
//! Deserializing validates what zod validates; serializing produces the API's JSON.

use std::fmt;
use std::str::FromStr;

use chrono::DateTime;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Number, Value};

use crate::js;

/// The outcome of an audited operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Completed successfully.
    Success,
    /// Completed with warnings.
    Warn,
    /// Failed.
    Fail,
    /// Skipped.
    Skip,
}

impl Status {
    /// Every status, in the order the API lists them.
    pub const ALL: [Status; 4] = [Status::Success, Status::Warn, Status::Fail, Status::Skip];

    /// The status as stored and sent: `success`, `warn`, `fail` or `skip`.
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Success => "success",
            Status::Warn => "warn",
            Status::Fail => "fail",
            Status::Skip => "skip",
        }
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A string that isn't one of [`Status::ALL`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid status: {0}")]
pub struct InvalidStatus(pub String);

impl FromStr for Status {
    type Err = InvalidStatus;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Status::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
            .ok_or_else(|| InvalidStatus(value.to_owned()))
    }
}

/// Escalation tier: who sees an audit. An integer from 1 to 3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "Number", into = "u8")]
pub struct Tier(u8);

impl Tier {
    /// Internal system audits, not shown to end users.
    pub const INTERNAL: Tier = Tier(1);
    /// Informational audits, shown in detailed views. The default.
    pub const INFO: Tier = Tier(2);
    /// Public audits, shown in summary views.
    pub const PUBLIC: Tier = Tier(3);

    /// The tier's number.
    pub fn get(self) -> u8 {
        self.0
    }
}

impl Default for Tier {
    fn default() -> Self {
        Tier::INFO
    }
}

impl From<Tier> for u8 {
    fn from(tier: Tier) -> u8 {
        tier.0
    }
}

impl TryFrom<u8> for Tier {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1..=3 => Ok(Tier(value)),
            _ => Err(format!("tier must be an integer from 1 to 3, got {value}")),
        }
    }
}

impl TryFrom<Number> for Tier {
    type Error = String;

    // JSON `2.0` is the integer 2 in JavaScript, so zod accepts it
    fn try_from(value: Number) -> Result<Self, Self::Error> {
        value
            .as_f64()
            .filter(|tier| tier.fract() == 0.0 && (1.0..=3.0).contains(tier))
            .map(|tier| Tier(tier as u8))
            .ok_or_else(|| format!("tier must be an integer from 1 to 3, got {value}"))
    }
}

/// A resource id: a string or a number.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum ResourceId {
    /// A string id.
    String(String),
    /// A numeric id.
    Number(Number),
}

impl ResourceId {
    /// The id as JavaScript's `String(id)` gives it: how it appears in keys and paths.
    pub fn to_key(&self) -> String {
        match self {
            ResourceId::String(id) => id.clone(),
            ResourceId::Number(id) => js::number_to_string(id),
        }
    }
}

impl Serialize for ResourceId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            ResourceId::String(id) => serializer.serialize_str(id),
            ResourceId::Number(id) => {
                let mut value = Value::Number(id.clone());
                js::normalize_numbers(&mut value);
                value.serialize(serializer)
            }
        }
    }
}

impl From<&str> for ResourceId {
    fn from(id: &str) -> Self {
        ResourceId::String(id.to_owned())
    }
}

/// A resource within an app: the target or source of an audit, or a related resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceReference {
    /// The app that owns the resource.
    pub app: String,
    /// The resource's id, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<ResourceId>,
    /// The resource type.
    #[serde(rename = "type")]
    pub resource_type: String,
}

/// Audit metadata: string keys with string, number, boolean or nested object values.
///
/// Arrays and `null` aren't allowed, at any depth.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Context(Map<String, Value>);

impl Context {
    /// The context's entries.
    pub fn as_map(&self) -> &Map<String, Value> {
        &self.0
    }
}

/// A context holding an array or `null`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("context values must be strings, numbers, booleans or objects; {0} is not")]
pub struct InvalidContext(pub String);

impl TryFrom<Map<String, Value>> for Context {
    type Error = InvalidContext;

    fn try_from(map: Map<String, Value>) -> Result<Self, Self::Error> {
        fn check(path: &str, value: &Value) -> Result<(), InvalidContext> {
            match value {
                Value::String(_) | Value::Number(_) | Value::Bool(_) => Ok(()),
                Value::Object(map) => map
                    .iter()
                    .try_for_each(|(key, value)| check(&format!("{path}.{key}"), value)),
                Value::Array(_) | Value::Null => Err(InvalidContext(path.to_owned())),
            }
        }

        map.iter().try_for_each(|(key, value)| check(key, value))?;
        Ok(Context(map))
    }
}

impl<'de> Deserialize<'de> for Context {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Context::try_from(Map::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// An ISO 8601 UTC timestamp, kept as given (`2026-01-02T03:04:05.678Z`).
///
/// Stored timestamps are strings and `GSI2_SS_SK` embeds one, so the text is kept
/// exactly rather than reformatted.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct Timestamp(String);

impl Timestamp {
    /// The timestamp's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<DateTime<chrono::Utc>> for Timestamp {
    fn from(time: DateTime<chrono::Utc>) -> Self {
        Timestamp(lambda_kit::clock::to_iso_string(time))
    }
}

impl TryFrom<String> for Timestamp {
    type Error = String;

    // zod's z.iso.datetime(): UTC ("Z"), any fractional precision
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.ends_with('Z') && DateTime::parse_from_rfc3339(&value).is_ok() {
            Ok(Timestamp(value))
        } else {
            Err(format!("expected an ISO 8601 UTC datetime, got {value:?}"))
        }
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Timestamp::try_from(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// The EventBridge event an audit records, so it can be re-sent.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct EventBridgeEvent {
    /// The event's source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The event's detail type.
    #[serde(
        rename = "detail-type",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub detail_type: Option<String>,
    /// The event's detail, as a JSON string. An object is stringified; a string is
    /// kept byte for byte, since a rerun re-sends it as is.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "detail"
    )]
    pub detail: Option<String>,
}

fn detail<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    match Option::<Value>::deserialize(deserializer)? {
        None => Ok(None),
        Some(Value::String(detail)) => Ok(Some(detail)),
        Some(detail @ Value::Object(_)) => Ok(Some(js::stringify(&detail))),
        Some(other) => Err(de::Error::custom(format!(
            "detail must be a string or an object, got {other}"
        ))),
    }
}

/// Reads an `error`: an object as is, or a string. A string holding a JSON object
/// (a serialized `Error`) is parsed back into the object; any other string is kept.
fn error_value<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    match Option::<Value>::deserialize(deserializer)? {
        None => Ok(None),
        Some(Value::String(text)) => Ok(Some(match serde_json::from_str(&text) {
            Ok(object @ Value::Object(_)) => object,
            _ => Value::String(text),
        })),
        Some(object @ Value::Object(_)) => Ok(Some(object)),
        Some(other) => Err(de::Error::custom(format!(
            "error must be a string or an object, got {other}"
        ))),
    }
}

/// One execution of the audited operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attempt {
    /// The attempt's number, from 1.
    #[serde(deserialize_with = "attempt_number")]
    pub number: u32,
    /// The attempt's outcome.
    pub status: Status,
    /// What went wrong, when it failed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "error_value"
    )]
    pub error: Option<Value>,
    /// When the attempt happened.
    pub at: Timestamp,
}

fn attempt_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let number = Number::deserialize(deserializer)?;
    number
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= f64::from(u32::MAX))
        .map(|n| n as u32)
        .ok_or_else(|| {
            de::Error::custom(format!(
                "attempt number must be an integer of at least 1, got {number}"
            ))
        })
}

/// An audit record, as the API returns it (`AuditPayloadSchema`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    /// The audit's id.
    pub id: String,
    /// The tenant, for multi-tenant apps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    /// The latest outcome.
    pub status: Status,
    /// Who sees the audit.
    #[serde(default)]
    pub tier: Tier,
    /// The resource the operation acted on.
    pub target: ResourceReference,
    /// The resource that started the operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ResourceReference>,
    /// Extra metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    /// The operation's name.
    pub operation: String,
    /// A human-readable description. `null` reads as absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Whether the recorded event can be re-sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerunable: Option<bool>,
    /// The trace, `{id}:{stage}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
    /// The event that triggered the operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<EventBridgeEvent>,
    /// What went wrong, when it failed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "error_value"
    )]
    pub error: Option<Value>,
    /// Every attempt, oldest first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<Vec<Attempt>>,
    /// When the audit last changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Timestamp>,
    /// When the audit was created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Timestamp>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn audit(value: Value) -> Result<Audit, serde_json::Error> {
        serde_json::from_value(value)
    }

    fn minimal() -> Value {
        json!({
            "id": "audit-1",
            "status": "fail",
            "target": { "app": "App1", "type": "Order", "id": "order-1" },
            "operation": "createOrder",
        })
    }

    #[test]
    fn parses_status_strings() {
        assert_eq!("warn".parse::<Status>(), Ok(Status::Warn));
        assert!("WARN".parse::<Status>().is_err());
        assert_eq!(Status::Skip.to_string(), "skip");
    }

    #[test]
    fn defaults_the_tier_to_info() {
        assert_eq!(audit(minimal()).unwrap().tier, Tier::INFO);
    }

    #[test]
    fn accepts_integral_tiers_only() {
        for (tier, ok) in [
            (json!(1), true),
            (json!(3.0), true),
            (json!(0), false),
            (json!(4), false),
            (json!(2.5), false),
        ] {
            let mut value = minimal();
            value["tier"] = tier.clone();

            assert_eq!(audit(value).is_ok(), ok, "{tier}");
        }
    }

    #[test]
    fn rejects_arrays_and_null_in_context() {
        let mut value = minimal();
        value["context"] = json!({ "attempt": 1, "nested": { "ok": false } });
        assert!(audit(value.clone()).is_ok());

        value["context"] = json!({ "nested": { "list": [1] } });
        let error = audit(value.clone()).unwrap_err().to_string();
        assert!(error.contains("nested.list"), "{error}");

        value["context"] = json!({ "missing": null });
        assert!(audit(value).is_err());
    }

    #[test]
    fn reads_a_null_message_as_absent() {
        let mut value = minimal();
        value["message"] = Value::Null;

        let parsed = audit(value).unwrap();

        assert_eq!(parsed.message, None);
        assert!(
            serde_json::to_value(&parsed)
                .unwrap()
                .get("message")
                .is_none()
        );
    }

    #[test]
    fn parses_error_strings_holding_json_objects_only() {
        let mut value = minimal();

        value["error"] = json!(r#"{"name":"Error","message":"Boom"}"#);
        assert_eq!(
            audit(value.clone()).unwrap().error,
            Some(json!({"name":"Error","message":"Boom"}))
        );

        // Previously JSON.parse turned "404" into the number 404
        value["error"] = json!("404");
        assert_eq!(audit(value.clone()).unwrap().error, Some(json!("404")));

        value["error"] = json!("Boom");
        assert_eq!(audit(value).unwrap().error, Some(json!("Boom")));
    }

    #[test]
    fn stringifies_an_object_detail_and_keeps_a_string_byte_for_byte() {
        let event: EventBridgeEvent = serde_json::from_value(
            json!({ "source": "orders", "detail": { "n": 1.0, "id": "a" } }),
        )
        .unwrap();
        assert_eq!(event.detail.as_deref(), Some(r#"{"n":1,"id":"a"}"#));

        let event: EventBridgeEvent =
            serde_json::from_value(json!({ "detail": r#"{"orderId":"order-1", "n":1.0}"# }))
                .unwrap();
        assert_eq!(
            event.detail.as_deref(),
            Some(r#"{"orderId":"order-1", "n":1.0}"#)
        );
    }

    #[test]
    fn formats_resource_ids_like_string_id() {
        let reference: ResourceReference =
            serde_json::from_value(json!({ "app": "App1", "type": "User", "id": 42.0 })).unwrap();

        assert_eq!(reference.id.as_ref().unwrap().to_key(), "42");
        assert_eq!(serde_json::to_value(&reference).unwrap()["id"], json!(42));
    }

    #[test]
    fn validates_timestamps() {
        assert!(Timestamp::try_from("2026-01-02T03:04:05.678Z".to_owned()).is_ok());
        assert!(Timestamp::try_from("2026-01-02T03:04:05Z".to_owned()).is_ok());
        assert!(Timestamp::try_from("2026-01-02T03:04:05+01:00".to_owned()).is_err());
        assert!(Timestamp::try_from("yesterday".to_owned()).is_err());
    }
}
