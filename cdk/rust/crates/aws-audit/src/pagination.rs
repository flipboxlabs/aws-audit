//! Listing pages and their `nextToken`s.
//!
//! A token is the unpadded base64url of a listing's `LastEvaluatedKey` as JSON,
//! e.g. `{"PK":"App1.Order","SK":"audit-1","LSI1_N_SK":21767323445678}`. Decoding
//! checks it against the queried index's key schema and partition, so a token a
//! listing didn't issue is refused before querying (`InvalidNextTokenError` in the
//! TypeScript SDK).

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::table::Index;

/// Items per page when the request doesn't say.
pub const DEFAULT_PAGE_SIZE: u32 = 100;

/// A decoded token: the key a query resumes after, in the token's key order.
pub type PageKey = Map<String, Value>;

/// The JSON type of a key attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyType {
    /// A string attribute.
    String,
    /// A number attribute.
    Number,
}

/// The attributes a `LastEvaluatedKey` holds, and their types.
pub type PageKeySchema = &'static [(&'static str, KeyType)];

/// Encodes without padding; decodes with or without it.
const TOKEN: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// A `nextToken` that isn't one the listing issued.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid pagination nextToken")]
pub struct InvalidNextToken;

/// Encodes a `LastEvaluatedKey` as a token.
pub fn encode(key: &PageKey) -> String {
    TOKEN.encode(Value::Object(key.clone()).to_string())
}

/// Decodes a token. `None` or an empty token means the first page.
///
/// With a `schema`, the token must hold exactly its attributes with their types;
/// without one, any string and number values.
pub fn decode(
    token: Option<&str>,
    schema: Option<PageKeySchema>,
) -> Result<Option<PageKey>, InvalidNextToken> {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Ok(None);
    };

    let bytes = TOKEN.decode(token).map_err(|_| InvalidNextToken)?;
    let Ok(Value::Object(key)) = serde_json::from_slice::<Value>(&bytes) else {
        return Err(InvalidNextToken);
    };

    let matches = match schema {
        Some(schema) => {
            key.len() == schema.len()
                && schema.iter().all(|(name, key_type)| {
                    matches!(
                        (key.get(*name), key_type),
                        (Some(Value::String(_)), KeyType::String)
                            | (Some(Value::Number(_)), KeyType::Number)
                    )
                })
        }
        None => key
            .values()
            .all(|value| value.is_string() || value.is_number()),
    };

    if matches {
        Ok(Some(key))
    } else {
        Err(InvalidNextToken)
    }
}

/// Decodes a listing's token into its `ExclusiveStartKey`: it must hold `index`'s
/// keys and belong to the queried `partition`, since DynamoDB rejects a start key
/// outside it.
pub fn exclusive_start_key(
    token: Option<&str>,
    index: Index,
    partition: &str,
) -> Result<Option<PageKey>, InvalidNextToken> {
    let key = decode(token, Some(index.page_key_schema()))?;

    match &key {
        Some(key) if key.get(index.partition_key()).and_then(Value::as_str) != Some(partition) => {
            Err(InvalidNextToken)
        }
        _ => Ok(key),
    }
}

/// What page of a listing to return.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pagination {
    /// Items per page; [`DEFAULT_PAGE_SIZE`] when `None` or 0.
    pub page_size: Option<u32>,
    /// Where the previous page ended.
    pub next_token: Option<String>,
}

impl Pagination {
    /// The query `Limit`.
    pub fn limit(&self) -> u32 {
        self.page_size
            .filter(|size| *size > 0)
            .unwrap_or(DEFAULT_PAGE_SIZE)
    }
}

/// A page of a listing: `{"items":[…],"pagination":{"nextToken":"…"}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Page<T> {
    /// The page's items.
    pub items: Vec<T>,
    /// Where the next page starts.
    #[serde(default)]
    pub pagination: PageInfo,
}

/// A page's position. `nextToken` is absent on the last page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    /// The token for the next page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn key(value: Value) -> PageKey {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    #[test]
    fn round_trips_keys_in_order() {
        let original =
            key(json!({ "PK": "App1.Order", "SK": "audit-1", "LSI1_N_SK": 21767323445678_u64 }));

        let token = encode(&original);

        assert!(!token.contains('='));
        let decoded = decode(Some(&token), Some(Index::Lsi1N.page_key_schema()))
            .unwrap()
            .unwrap();
        assert_eq!(decoded, original);
        assert_eq!(
            decoded.keys().collect::<Vec<_>>(),
            ["PK", "SK", "LSI1_N_SK"]
        );
    }

    #[test]
    fn treats_missing_and_empty_tokens_as_the_first_page() {
        assert_eq!(decode(None, None), Ok(None));
        assert_eq!(decode(Some(""), None), Ok(None));
    }

    #[test]
    fn accepts_padded_tokens() {
        let token = format!("{}=", encode(&key(json!({ "PK": "a" }))));

        assert!(decode(Some(&token), None).is_ok());
    }

    #[test]
    fn rejects_tokens_that_are_not_key_objects() {
        for token in [
            "not a token!".to_owned(),
            TOKEN.encode("[1]"),
            TOKEN.encode("\"PK\""),
            TOKEN.encode("null"),
            TOKEN.encode(r#"{"PK":{"S":"x"}}"#),
            TOKEN.encode(r#"{"PK":true}"#),
        ] {
            assert_eq!(decode(Some(&token), None), Err(InvalidNextToken), "{token}");
        }
    }

    #[test]
    fn rejects_tokens_that_do_not_match_the_schema() {
        let schema = Some(Index::Lsi1N.page_key_schema());

        for value in [
            json!({ "PK": "App1.USER", "SK": "audit-123" }),
            json!({ "PK": "App1.USER", "SK": "audit-123", "LSI1_N_SK": 1, "GSI2_SS_PK": "fail" }),
            json!({ "PK": "App1.USER", "SK": "audit-123", "LSI1_N_SK": "1" }),
        ] {
            let token = encode(&key(value.clone()));
            assert_eq!(
                decode(Some(&token), schema),
                Err(InvalidNextToken),
                "{value}"
            );
        }
    }

    #[test]
    fn rejects_start_keys_outside_the_partition() {
        let token = encode(&key(json!({
            "PK": "App1.Order", "SK": "audit-1", "GSI2_SS_PK": "warn", "GSI2_SS_SK": "x",
        })));

        assert!(exclusive_start_key(Some(&token), Index::Gsi2Ss, "warn").is_ok());
        assert_eq!(
            exclusive_start_key(Some(&token), Index::Gsi2Ss, "fail"),
            Err(InvalidNextToken)
        );
    }

    #[test]
    fn defaults_the_page_size() {
        assert_eq!(Pagination::default().limit(), 100);
        assert_eq!(
            Pagination {
                page_size: Some(0),
                next_token: None
            }
            .limit(),
            100
        );
        assert_eq!(
            Pagination {
                page_size: Some(25),
                next_token: None
            }
            .limit(),
            25
        );
    }

    #[test]
    fn serializes_an_empty_pagination_on_the_last_page() {
        let page = Page {
            items: vec![1],
            pagination: PageInfo::default(),
        };

        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            json!({ "items": [1], "pagination": {} })
        );
    }
}
