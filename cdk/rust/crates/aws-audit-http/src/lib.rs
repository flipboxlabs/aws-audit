//! What the audit REST Lambdas share on top of [`lambda_kit::http`]: the
//! pagination and filter queries, checks against the configured apps, resource
//! types and statuses, and audit errors as HTTP errors.
//!
//! Issue messages are zod's, so a 422 answers the same body as the TypeScript
//! handlers did.

use std::fmt;

use aws_audit::AuditConfig;
use aws_audit::model::{Audit, Status, Tier};
use aws_audit::pagination::Pagination;
use aws_audit::service::{AuditService, ServiceError};
use aws_audit::storage::{Identifiers, ListFilter, ResourceFilter, StorageError};
use lambda_kit::http::{self, HttpError, HttpRequest, Issue, Issues};

#[cfg(feature = "testing")]
pub mod testing;

/// The page size query parameter.
pub const PAGE_SIZE: &str = "pagination[pageSize]";

/// The next token query parameter.
pub const NEXT_TOKEN: &str = "pagination[nextToken]";

/// The largest page a listing returns.
pub const MAX_PAGE_SIZE: u32 = 1000;

/// The operation filter query parameter.
pub const FILTER_OPERATION: &str = "filter[operation]";

/// The tier filter query parameter.
pub const FILTER_TIER: &str = "filter[tier]";

/// The app filter query parameter (status and trace listings).
pub const FILTER_APP: &str = "filter[app]";

/// The resource type filter query parameter (status and trace listings).
pub const FILTER_RESOURCE_TYPE: &str = "filter[resourceType]";

/// A value that isn't one of the options it must be.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct InvalidOption(Vec<String>);

impl fmt::Display for InvalidOption {
    // zod's message: Invalid option: expected one of "App1"|"TestApp"
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let options: Vec<String> = self.0.iter().map(|option| format!("{option:?}")).collect();
        write!(f, "Invalid option: expected one of {}", options.join("|"))
    }
}

fn one_of<'a>(
    value: &str,
    options: impl IntoIterator<Item = &'a str>,
) -> Result<String, InvalidOption> {
    let options: Vec<&str> = options.into_iter().collect();
    if options.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(InvalidOption(
            options.into_iter().map(str::to_owned).collect(),
        ))
    }
}

/// The app, if the config lists it.
pub fn app(config: &AuditConfig, value: &str) -> Result<String, InvalidOption> {
    one_of(value, config.apps.iter().map(String::as_str))
}

/// The resource type, if the config lists it.
pub fn resource_type(config: &AuditConfig, value: &str) -> Result<String, InvalidOption> {
    one_of(value, config.resource_types.iter().map(String::as_str))
}

/// The status, if it is one.
pub fn status(value: &str) -> Result<Status, InvalidOption> {
    let value = one_of(value, Status::ALL.map(Status::as_str))?;
    Ok(value.parse().expect("one of Status::ALL"))
}

/// A `pagination[pageSize]`: an integer from 1 to 1000, written without leading
/// zeros or a sign (`^(?:[1-9]\d{0,2}|1000)$` in TypeScript).
pub fn page_size(value: &str) -> Result<u32, &'static str> {
    const MESSAGE: &str = "Expected an integer from 1 to 1000";

    let digits =
        value.len() <= 4 && !value.starts_with('0') && value.bytes().all(|b| b.is_ascii_digit());
    match value.parse::<u32>() {
        Ok(size @ 1..=MAX_PAGE_SIZE) if digits => Ok(size),
        _ => Err(MESSAGE),
    }
}

/// A `filter[tier]`: `1`, `2` or `3`.
pub fn tier(value: &str) -> Result<Tier, InvalidOption> {
    let value = one_of(value, ["1", "2", "3"])?;
    Ok(Tier::try_from(value.parse::<u8>().expect("a digit")).expect("a tier from 1 to 3"))
}

/// A `filter[operation]`: any operation name, but not an empty one.
pub fn operation(value: &str) -> Result<String, &'static str> {
    if value.is_empty() {
        Err("Too small: expected string to have >=1 characters")
    } else {
        Ok(value.to_owned())
    }
}

/// The filters every listing takes: `filter[operation]` and `filter[tier]`.
/// Invalid ones are recorded in `issues`.
pub fn list_filter(request: &HttpRequest, issues: &mut Issues) -> ListFilter {
    ListFilter {
        operation: request
            .query(FILTER_OPERATION)
            .and_then(|value| issues.check(["query", FILTER_OPERATION], operation(value))),
        tier: request
            .query(FILTER_TIER)
            .and_then(|value| issues.check(["query", FILTER_TIER], tier(value))),
    }
}

/// The status and trace listings' resource filters: `filter[app]` and
/// `filter[resourceType]`, which must be configured. Invalid ones are recorded in
/// `issues`.
pub fn resource_filter(
    config: &AuditConfig,
    request: &HttpRequest,
    issues: &mut Issues,
) -> ResourceFilter {
    ResourceFilter {
        app: request
            .query(FILTER_APP)
            .and_then(|value| issues.check(["query", FILTER_APP], app(config, value))),
        resource_type: request.query(FILTER_RESOURCE_TYPE).and_then(|value| {
            issues.check(
                ["query", FILTER_RESOURCE_TYPE],
                resource_type(config, value),
            )
        }),
        resource_id: None,
    }
}

/// The request's pagination. An invalid page size is recorded in `issues`; the
/// next token is checked by the listing.
pub fn pagination(request: &HttpRequest, issues: &mut Issues) -> Pagination {
    Pagination {
        page_size: request
            .query(PAGE_SIZE)
            .and_then(|value| issues.check(["query", PAGE_SIZE], page_size(value))),
        next_token: request.query(NEXT_TOKEN).map(str::to_owned),
    }
}

/// The `{app}` and `{object}` path parameters every `/apps/{app}/objects/{object}`
/// route has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectPath {
    /// `{app}`, one the config lists.
    pub app: String,
    /// `{object}`, a resource type the config lists.
    pub resource_type: String,
}

impl ObjectPath {
    /// The path's app and resource type, or `None` after recording what's wrong
    /// with them in `issues`.
    pub fn from_request(
        config: &AuditConfig,
        request: &HttpRequest,
        issues: &mut Issues,
    ) -> Option<Self> {
        let app = issues.check(["path", "app"], app(config, request.param("app")));
        let resource_type = issues.check(
            ["path", "object"],
            resource_type(config, request.param("object")),
        );

        Some(ObjectPath {
            app: app?,
            resource_type: resource_type?,
        })
    }

    /// The identifiers of audit `id` under this path.
    pub fn audit(&self, id: &str) -> Identifiers {
        Identifiers {
            tenant_id: None,
            app: self.app.clone(),
            resource_type: self.resource_type.clone(),
            id: id.to_owned(),
        }
    }
}

/// The audit at `identifiers`, as `/apps/{app}/objects/{object}/{item}/{audit}`
/// addresses it: a 404 `Audit not found` when it's missing, or when its target
/// is another item than `item`. The lookup itself ignores `{item}`. A target
/// without an id can't be told apart, so any `item` finds it.
pub async fn audit_of_item(
    service: &AuditService,
    identifiers: &Identifiers,
    item: &str,
) -> http::Result<Audit> {
    let audit = service.get_item(identifiers).await.map_err(service_error)?;

    match &audit.target.id {
        Some(id) if id.to_key() != item => Err(HttpError::not_found(NOT_FOUND).into()),
        _ => Ok(audit),
    }
}

const NOT_FOUND: &str = "Audit not found";

/// An audit operation's failure as an HTTP error:
///
/// - a missing audit is a 404 `Audit not found`;
/// - a `nextToken` the listing didn't issue is a 422 on `pagination[nextToken]`;
/// - anything else is a logged 500.
pub fn service_error(error: ServiceError) -> http::Error {
    match error {
        ServiceError::NotFound(_) => HttpError::not_found(NOT_FOUND).into(),
        ServiceError::Storage(StorageError::InvalidNextToken(_)) => {
            HttpError::validation(vec![Issue {
                message: "Invalid pagination token".to_owned(),
                path: vec!["query".to_owned(), NEXT_TOKEN.to_owned()],
            }])
            .into()
        }
        error => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use aws_audit::pagination::InvalidNextToken;
    use aws_audit::service::AuditNotFound;
    use aws_audit::storage::Identifiers;
    use lambda_http::http::StatusCode;

    use super::*;

    fn config() -> AuditConfig {
        aws_audit::testing::contract_config()
    }

    #[test]
    fn accepts_configured_values() {
        assert_eq!(app(&config(), "App1"), Ok("App1".to_owned()));
        assert_eq!(resource_type(&config(), "Order"), Ok("Order".to_owned()));
        assert_eq!(status("fail"), Ok(Status::Fail));
    }

    #[test]
    fn lists_the_options_as_zod_does() {
        assert_eq!(
            app(&config(), "Nope").unwrap_err().to_string(),
            r#"Invalid option: expected one of "App1"|"TestApp""#
        );
        assert_eq!(
            status("unknown").unwrap_err().to_string(),
            r#"Invalid option: expected one of "success"|"warn"|"fail"|"skip""#
        );
    }

    #[test]
    fn accepts_tiers_from_1_to_3() {
        assert_eq!(tier("1"), Ok(Tier::try_from(1).unwrap()));
        assert_eq!(tier("3"), Ok(Tier::try_from(3).unwrap()));
        for value in ["", "0", "4", "01", "1.0", " 2"] {
            assert_eq!(
                tier(value).unwrap_err().to_string(),
                r#"Invalid option: expected one of "1"|"2"|"3""#,
                "{value}"
            );
        }
    }

    #[test]
    fn refuses_an_empty_operation() {
        assert_eq!(operation("createOrder"), Ok("createOrder".to_owned()));
        assert!(operation("").is_err());
    }

    #[test]
    fn accepts_page_sizes_from_1_to_1000() {
        for (value, size) in [("1", 1), ("25", 25), ("999", 999), ("1000", 1000)] {
            assert_eq!(page_size(value), Ok(size), "{value}");
        }
        for value in [
            "",
            "0",
            "01",
            "-1",
            "+5",
            "1001",
            "1e2",
            " 5",
            "5.0",
            "99999999999",
        ] {
            assert!(page_size(value).is_err(), "{value}");
        }
    }

    #[test]
    fn maps_service_errors() {
        let status = |error: ServiceError| match service_error(error) {
            http::Error::Http(error) => Some(error.status()),
            http::Error::Unhandled(_) => None,
        };

        let identifiers = Identifiers {
            tenant_id: None,
            app: "App1".to_owned(),
            resource_type: "Order".to_owned(),
            id: "audit-1".to_owned(),
        };
        assert_eq!(
            status(AuditNotFound(identifiers).into()),
            Some(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            status(StorageError::InvalidNextToken(InvalidNextToken).into()),
            Some(StatusCode::UNPROCESSABLE_ENTITY)
        );
        assert_eq!(status(StorageError::MissingAttributes.into()), None);
    }
}
