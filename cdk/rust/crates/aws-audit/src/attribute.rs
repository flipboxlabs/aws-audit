//! Converts between JSON values and DynamoDB attribute values, as `marshall` and
//! `unmarshall` from `@aws-sdk/util-dynamodb` do for the TypeScript SDK.

use std::collections::HashMap;

use aws_sdk_dynamodb::types::AttributeValue;
use serde_json::{Map, Number, Value};

use crate::js;

/// A DynamoDB item or key.
pub type Item = HashMap<String, AttributeValue>;

/// How to marshall, mirroring `marshall`'s options.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Marshall {
    /// Write empty strings as `NULL` (`convertEmptyValues`).
    pub convert_empty_values: bool,
}

impl Marshall {
    /// `marshall(value)` with no options.
    pub const PLAIN: Marshall = Marshall {
        convert_empty_values: false,
    };

    /// `marshall(value, { convertEmptyValues: true, … })`, as the SDK writes items.
    pub const ITEM: Marshall = Marshall {
        convert_empty_values: true,
    };

    /// One value.
    pub fn value(self, value: &Value) -> AttributeValue {
        match value {
            Value::Null => AttributeValue::Null(true),
            Value::Bool(value) => AttributeValue::Bool(*value),
            Value::Number(number) => AttributeValue::N(js::number_to_string(number)),
            Value::String(text) if text.is_empty() && self.convert_empty_values => {
                AttributeValue::Null(true)
            }
            Value::String(text) => AttributeValue::S(text.clone()),
            Value::Array(items) => AttributeValue::L(items.iter().map(|v| self.value(v)).collect()),
            Value::Object(map) => AttributeValue::M(self.map(map)),
        }
    }

    /// An object's entries.
    pub fn map(self, map: &Map<String, Value>) -> Item {
        map.iter()
            .map(|(key, value)| (key.clone(), self.value(value)))
            .collect()
    }
}

/// `unmarshall` for one value. Numbers become JavaScript numbers: integers when
/// they have no fraction, else floats.
pub fn unmarshall(value: &AttributeValue) -> Value {
    match value {
        AttributeValue::S(text) => Value::String(text.clone()),
        AttributeValue::N(text) => number(text),
        AttributeValue::Bool(value) => Value::Bool(*value),
        AttributeValue::Null(_) => Value::Null,
        AttributeValue::L(items) => Value::Array(items.iter().map(unmarshall).collect()),
        AttributeValue::M(map) => Value::Object(unmarshall_map(map)),
        AttributeValue::Ss(items) => items.iter().cloned().map(Value::String).collect(),
        AttributeValue::Ns(items) => items.iter().map(|text| number(text)).collect(),
        // Binary attributes aren't part of an audit
        _ => Value::Null,
    }
}

/// `unmarshall` for an item, keys sorted so the result doesn't depend on the
/// map's iteration order.
pub fn unmarshall_map(item: &Item) -> Map<String, Value> {
    let mut keys: Vec<_> = item.keys().collect();
    keys.sort();
    keys.into_iter()
        .map(|key| (key.clone(), unmarshall(&item[key])))
        .collect()
}

fn number(text: &str) -> Value {
    if let Ok(integer) = text.parse::<i64>() {
        return Value::Number(integer.into());
    }
    if let Ok(integer) = text.parse::<u64>() {
        return Value::Number(integer.into());
    }

    let mut value = text
        .parse::<f64>()
        .ok()
        .and_then(Number::from_f64)
        .map_or(Value::Null, Value::Number);
    js::normalize_numbers(&mut value);
    value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn marshalls_like_util_dynamodb() {
        let value =
            json!({ "s": "a", "n": 1.0, "b": false, "nil": null, "l": [], "m": { "x": 42 } });

        let Value::Object(map) = value else {
            unreachable!()
        };
        let item = Marshall::PLAIN.map(&map);

        assert_eq!(item["s"], AttributeValue::S("a".into()));
        assert_eq!(item["n"], AttributeValue::N("1".into()));
        assert_eq!(item["b"], AttributeValue::Bool(false));
        assert_eq!(item["nil"], AttributeValue::Null(true));
        assert_eq!(item["l"], AttributeValue::L(vec![]));
        assert_eq!(
            item["m"],
            AttributeValue::M(HashMap::from([(
                "x".into(),
                AttributeValue::N("42".into())
            )]))
        );
    }

    #[test]
    fn converts_empty_strings_only_when_asked() {
        assert_eq!(
            Marshall::PLAIN.value(&json!("")),
            AttributeValue::S(String::new())
        );
        assert_eq!(Marshall::ITEM.value(&json!("")), AttributeValue::Null(true));
    }

    #[test]
    fn unmarshalls_numbers_as_javascript_numbers() {
        assert_eq!(
            unmarshall(&AttributeValue::N("21767323045678".into())),
            json!(21767323045678_u64)
        );
        assert_eq!(unmarshall(&AttributeValue::N("1.5".into())), json!(1.5));
        assert_eq!(unmarshall(&AttributeValue::N("2.0".into())), json!(2));
    }
}
