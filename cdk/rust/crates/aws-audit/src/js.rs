//! JavaScript number formatting, so values built here match the TypeScript SDK's.
//!
//! JSON numbers are `f64` in JavaScript: `1.0` parses to `1`, and `String(n)` and
//! `JSON.stringify` print it as `1`. serde_json keeps `1.0` as a float and prints
//! `1.0`. Anything that becomes part of a key, a DynamoDB number or a JSON string
//! the TypeScript code also produces goes through here.

use serde_json::{Number, Value};

/// Largest integer a JavaScript number holds exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Formats a number as JavaScript's `String(n)` does.
pub fn number_to_string(number: &Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }

    format_f64(number.as_f64().unwrap_or(f64::NAN))
}

fn format_f64(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }

    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        // Rust's shortest round-trip form, like JavaScript's, without an exponent
        return value.to_string();
    }

    // JavaScript writes the exponent with a sign: 1e+21, 1.5e-7
    let formatted = format!("{value:e}");
    match formatted.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => formatted,
    }
}

/// Rewrites floats that hold a safe integer (`1.0`) as integers (`1`), recursively,
/// so the value serializes as `JSON.stringify` would.
pub fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            if let Some(float) = number.as_f64().filter(|_| number.is_f64())
                && float.fract() == 0.0
                && float.abs() <= MAX_SAFE_INTEGER
            {
                *number = Number::from(float as i64);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Value::Object(map) => map.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// `JSON.stringify(value)`: compact, keys in insertion order, JavaScript numbers.
pub fn stringify(value: &Value) -> String {
    let mut value = value.clone();
    normalize_numbers(&mut value);
    value.to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn number(text: &str) -> Number {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn formats_numbers_like_string_n() {
        for (input, expected) in [
            ("1", "1"),
            ("-7", "-7"),
            ("1.0", "1"),
            ("1.5", "1.5"),
            ("0.1", "0.1"),
            ("0.0", "0"),
            ("21767323445678", "21767323445678"),
            ("1e21", "1e+21"),
            ("1.5e-7", "1.5e-7"),
            ("0.000001", "0.000001"),
        ] {
            assert_eq!(number_to_string(&number(input)), expected, "{input}");
        }
    }

    #[test]
    fn stringifies_like_json_stringify() {
        let value: Value =
            serde_json::from_str(r#"{"orderId":"order-1", "n":1.0, "x":[2.0, 2.5]}"#).unwrap();

        assert_eq!(
            stringify(&value),
            r#"{"orderId":"order-1","n":1,"x":[2,2.5]}"#
        );
    }

    #[test]
    fn keeps_unsafe_integers_as_floats() {
        let mut value = json!(1e300);

        normalize_numbers(&mut value);

        assert!(value.as_f64().is_some_and(|f| f == 1e300));
        assert!(value.is_f64());
    }
}
