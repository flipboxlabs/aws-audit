//! REST handlers behind API Gateway, the way Powertools' event handler serves the
//! TypeScript Lambdas: a [`Router`] that sends each request to its route's handler,
//! [`HttpError`]s answered as `{statusCode, error, message[, details]}`, request
//! validation that reports every [`Issue`] in one 422, and a catch-all 500 that
//! logs what went wrong.
//!
//! ```no_run
//! use std::sync::Arc;
//!
//! use lambda_kit::http::{self, HttpRequest, Issues, Router};
//!
//! async fn order(_state: Arc<()>, request: HttpRequest) -> http::Result {
//!     let mut issues = Issues::default();
//!     let id = issues.check(["path", "id"], request.param("id").parse::<u32>().map_err(|_| "Expected a number"));
//!     issues.finish()?;
//!
//!     Ok(http::json(200, &serde_json::json!({ "id": id })))
//! }
//!
//! # async fn run() -> Result<(), http::RuntimeError> {
//! http::run(Router::new(()).get("/orders/{id}", order)).await
//! # }
//! ```

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use lambda_http::http::Method;
use lambda_http::http::header::CONTENT_TYPE;
use lambda_http::request::RequestContext;
use lambda_http::{Body, Request, RequestExt, Response};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{Value, json};

use crate::logging::ErrorChain;

pub use lambda_http::http::StatusCode;

/// What a handler returns.
pub type Result<T = Response<Body>> = std::result::Result<T, Error>;

/// An error with an HTTP status, answered as
/// `{"statusCode": 404, "error": "NotFoundError", "message": "Audit not found"}`.
///
/// `error` is the TypeScript error class's name, so both answer the same body.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpError {
    status: StatusCode,
    error: &'static str,
    message: String,
    details: Option<Value>,
}

impl HttpError {
    /// An error answered with `status`, `error` as its name.
    pub fn new(status: StatusCode, error: &'static str, message: impl Into<String>) -> Self {
        HttpError {
            status,
            error,
            message: message.into(),
            details: None,
        }
    }

    /// 400 `BadRequestError`.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "BadRequestError", message)
    }

    /// 404 `NotFoundError`.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "NotFoundError", message)
    }

    /// 422 `RequestValidationError`, listing each issue under `details.issues`.
    pub fn validation(issues: Vec<Issue>) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "RequestValidationError",
            "Validation failed for request",
        )
        .with_details(json!({ "issues": issues }))
    }

    /// 500 `InternalServerError`, saying nothing about the cause.
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "InternalServerError",
            "Internal Server Error",
        )
    }

    /// Adds `details` to the body.
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// The status answered.
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The response answering this error.
    pub fn to_response(&self) -> Response<Body> {
        let mut body = json!({
            "statusCode": self.status.as_u16(),
            "error": self.error,
            "message": self.message,
        });
        if let Some(details) = &self.details {
            body["details"] = details.clone();
        }
        json(self.status, &body)
    }
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.status.as_u16(),
            self.error,
            self.message
        )
    }
}

/// Why a handler failed: an [`HttpError`] to answer as it is, or anything else,
/// answered as a logged 500.
///
/// `?` converts both, so a handler can return any error.
#[derive(Debug)]
pub enum Error {
    /// Answered as it is.
    Http(HttpError),
    /// Logged, and answered with [`HttpError::internal`].
    Unhandled(Box<dyn std::error::Error + Send + Sync>),
}

impl From<HttpError> for Error {
    fn from(error: HttpError) -> Self {
        Error::Http(error)
    }
}

// HttpError isn't a std error, so this doesn't overlap the impl above
impl<E: std::error::Error + Send + Sync + 'static> From<E> for Error {
    fn from(error: E) -> Self {
        Error::Unhandled(Box::new(error))
    }
}

/// A request input that failed validation: `path` is where it is, e.g.
/// `["query", "filter[app]"]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    /// What's wrong.
    pub message: String,
    /// Where: the request part (`path`, `query`), then the name.
    pub path: Vec<String>,
}

/// Collects a request's issues, so one 422 reports them all.
///
/// Check the path before the query, as Powertools does, so issues are listed in
/// the same order.
#[derive(Debug, Default)]
pub struct Issues(Vec<Issue>);

impl Issues {
    /// Records an issue at `path`.
    pub fn add<'a>(&mut self, path: impl IntoIterator<Item = &'a str>, message: impl Into<String>) {
        self.0.push(Issue {
            message: message.into(),
            path: path.into_iter().map(str::to_owned).collect(),
        });
    }

    /// The value, or `None` after recording its error as an issue at `path`.
    pub fn check<'a, T, E: fmt::Display>(
        &mut self,
        path: impl IntoIterator<Item = &'a str>,
        result: std::result::Result<T, E>,
    ) -> Option<T> {
        result
            .map_err(|error| self.add(path, error.to_string()))
            .ok()
    }

    /// A 422 listing the issues, if there are any.
    pub fn finish(self) -> std::result::Result<(), HttpError> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(HttpError::validation(self.0))
        }
    }
}

/// A JSON response.
pub fn json(status: impl TryInto<StatusCode>, body: &impl Serialize) -> Response<Body> {
    let status = status
        .try_into()
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = serde_json::to_string(body).expect("a JSON response body serializes");

    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::Text(body))
        .expect("a JSON response is valid")
}

/// A 204: no body, so no content type.
pub fn no_content() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::Empty)
        .expect("a 204 response is valid")
}

/// A routed request, with its route's path parameters.
#[derive(Debug)]
pub struct HttpRequest {
    request: Request,
    params: HashMap<String, String>,
}

impl HttpRequest {
    /// A path parameter, decoded. Empty when the route doesn't have it.
    pub fn param(&self, name: &str) -> &str {
        self.params.get(name).map_or("", String::as_str)
    }

    /// A query parameter. When it's given more than once the last one counts,
    /// as with `URLSearchParams`.
    pub fn query(&self, name: &str) -> Option<&str> {
        self.request
            .query_string_parameters_ref()?
            .all(name)?
            .last()
            .copied()
    }

    /// The request as the runtime gave it.
    pub fn inner(&self) -> &Request {
        &self.request
    }
}

type Handler<S> =
    Box<dyn Fn(Arc<S>, HttpRequest) -> Pin<Box<dyn Future<Output = Result> + Send>> + Send + Sync>;

struct Route<S> {
    method: Method,
    template: String,
    segments: Vec<Segment>,
    handler: Handler<S>,
}

enum Segment {
    Literal(String),
    Param(String),
}

/// Sends each request to its route's handler, with shared state `S`.
///
/// Routes are API Gateway resource paths, e.g. `/status/{status}`. A request is
/// matched by the resource API Gateway routed it by, when the event has one, so
/// stages and encoded characters in ids don't affect routing; otherwise by its
/// path. A request no route matches is a 404.
pub struct Router<S> {
    state: Arc<S>,
    routes: Vec<Route<S>>,
}

impl<S: Send + Sync + 'static> Router<S> {
    /// A router without routes, giving each handler `state`.
    pub fn new(state: S) -> Self {
        Router {
            state: Arc::new(state),
            routes: Vec::new(),
        }
    }

    /// Adds a route.
    pub fn route<F, Fut>(mut self, method: Method, template: &str, handler: F) -> Self
    where
        F: Fn(Arc<S>, HttpRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result> + Send + 'static,
    {
        let segments = template
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(
                |segment| match segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                    Some(name) => Segment::Param(name.to_owned()),
                    None => Segment::Literal(segment.to_owned()),
                },
            )
            .collect();

        self.routes.push(Route {
            method,
            template: template.to_owned(),
            segments,
            handler: Box::new(move |state, request| Box::pin(handler(state, request))),
        });
        self
    }

    /// Adds a `GET` route.
    pub fn get<F, Fut>(self, template: &str, handler: F) -> Self
    where
        F: Fn(Arc<S>, HttpRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result> + Send + 'static,
    {
        self.route(Method::GET, template, handler)
    }

    /// Adds a `POST` route.
    pub fn post<F, Fut>(self, template: &str, handler: F) -> Self
    where
        F: Fn(Arc<S>, HttpRequest) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result> + Send + 'static,
    {
        self.route(Method::POST, template, handler)
    }

    /// Answers a request. Never fails: an error is answered as its status, and
    /// anything but an [`HttpError`] is logged and answered as a 500.
    pub async fn handle(&self, request: Request) -> Response<Body> {
        let Some((route, params)) = self.resolve(&request) else {
            return HttpError::not_found(format!(
                "Route {} for method {} not found",
                request.raw_http_path(),
                request.method()
            ))
            .to_response();
        };

        let request = HttpRequest { request, params };
        match (route.handler)(self.state.clone(), request).await {
            Ok(response) => response,
            Err(Error::Http(error)) => error.to_response(),
            Err(Error::Unhandled(error)) => {
                tracing::error!(error = %ErrorChain(error.as_ref()), "Unhandled error");
                HttpError::internal().to_response()
            }
        }
    }

    /// The request's route and its path parameters.
    fn resolve(&self, request: &Request) -> Option<(&Route<S>, HashMap<String, String>)> {
        let routes = self
            .routes
            .iter()
            .filter(|route| route.method == request.method());

        if let Some(resource) = routed_resource(request) {
            let route = routes.clone().find(|route| route.template == resource);
            if let Some(route) = route {
                let params = request
                    .path_parameters_ref()
                    .map(|params| {
                        params
                            .iter()
                            .map(|(name, value)| (name.to_owned(), value.to_owned()))
                            .collect()
                    })
                    .unwrap_or_default();
                return Some((route, params));
            }
        }

        let segments: Vec<&str> = request
            .raw_http_path()
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        routes
            .into_iter()
            .find_map(|route| Some((route, route.matches(&segments)?)))
    }
}

impl<S> Route<S> {
    /// The path parameters, if `segments` is this route's path.
    fn matches(&self, segments: &[&str]) -> Option<HashMap<String, String>> {
        if segments.len() != self.segments.len() {
            return None;
        }

        let mut params = HashMap::new();
        for (segment, expected) in segments.iter().zip(&self.segments) {
            let value = percent_decode_str(segment).decode_utf8().ok()?;
            match expected {
                Segment::Literal(literal) if *literal == value => {}
                Segment::Literal(_) => return None,
                Segment::Param(name) => {
                    params.insert(name.clone(), value.into_owned());
                }
            }
        }
        Some(params)
    }
}

/// The resource path API Gateway routed the request by: the REST API's resource,
/// or an HTTP API's route key without its method.
fn routed_resource(request: &Request) -> Option<String> {
    match request.request_context_ref()? {
        RequestContext::ApiGatewayV1(context) => context.resource_path.clone(),
        RequestContext::ApiGatewayV2(context) => context
            .route_key
            .as_deref()?
            .split_once(' ')
            .map(|(_, path)| path.to_owned()),
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

/// Why the runtime stopped, or a Lambda's init failed: any error.
pub type RuntimeError = lambda_http::Error;

/// Runs `router` on the Lambda runtime.
pub async fn run<S: Send + Sync + 'static>(
    router: Router<S>,
) -> std::result::Result<(), RuntimeError> {
    let router = &router;
    lambda_http::run(lambda_http::service_fn(
        move |request: Request| async move {
            Ok::<_, std::convert::Infallible>(router.handle(request).await)
        },
    ))
    .await
}

#[cfg(test)]
mod tests {
    use lambda_http::request::LambdaRequest;

    use super::*;
    use crate::testing::LogCapture;

    #[derive(Debug, thiserror::Error)]
    #[error("connection reset")]
    struct Reset;

    #[derive(Debug, thiserror::Error)]
    #[error("unable to query")]
    struct QueryFailed(#[source] Reset);

    fn router() -> Router<&'static str> {
        Router::new("state")
            .get("/orders/{id}", |state, request| async move {
                Ok(json(
                    200,
                    &json!({ "state": *state, "id": request.param("id") }),
                ))
            })
            .get("/orders/{id}/lines", |_, request| async move {
                let mut issues = Issues::default();
                issues.check(
                    ["path", "id"],
                    request
                        .param("id")
                        .parse::<u32>()
                        .map_err(|_| "Expected a number"),
                );
                issues.check(
                    ["query", "page"],
                    request
                        .query("page")
                        .unwrap_or("1")
                        .parse::<u32>()
                        .map_err(|_| "Expected a number"),
                );
                issues.finish()?;
                Ok(no_content())
            })
            .post("/orders/{id}/lines", |_, _| async move {
                Err(HttpError::bad_request("Order is closed"))?
            })
            .get("/fail", |_, _| async move { Err(QueryFailed(Reset))? })
    }

    /// A REST (v1) proxy event, as API Gateway sends it.
    fn request(
        method: &str,
        resource: Option<&str>,
        path: &str,
        query: &[(&str, &str)],
    ) -> Request {
        let mut params = serde_json::Map::new();
        if let Some(resource) = resource {
            let values: Vec<&str> = path.split('/').collect();
            for (index, segment) in resource.split('/').enumerate() {
                if let Some(name) = segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                    let value = percent_decode_str(values[index]).decode_utf8().unwrap();
                    params.insert(name.to_owned(), json!(value));
                }
            }
        }
        let mut multi = serde_json::Map::new();
        for (key, value) in query {
            multi
                .entry(key.to_string())
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .unwrap()
                .push(json!(value));
        }

        let event = json!({
            "resource": resource,
            "path": path,
            "httpMethod": method,
            "headers": {},
            "multiValueHeaders": {},
            "pathParameters": if params.is_empty() { Value::Null } else { Value::Object(params) },
            "queryStringParameters": Value::Null,
            "multiValueQueryStringParameters": if multi.is_empty() { Value::Null } else { Value::Object(multi) },
            "body": Value::Null,
            "isBase64Encoded": false,
            "requestContext": { "httpMethod": method, "resourcePath": resource, "stage": "v1" },
        });
        serde_json::from_value::<LambdaRequest>(event)
            .unwrap()
            .into()
    }

    async fn answer(request: Request) -> (u16, Option<String>, Value) {
        let response = router().handle(request).await;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .map(|value| value.to_str().unwrap().to_owned());
        let body = match response.body() {
            Body::Text(text) => serde_json::from_str(text).unwrap(),
            Body::Empty => Value::Null,
            _ => panic!("binary body"),
        };
        (response.status().as_u16(), content_type, body)
    }

    #[tokio::test]
    async fn routes_by_the_resource_api_gateway_matched() {
        let (status, content_type, body) =
            answer(request("GET", Some("/orders/{id}"), "/orders/a%2Fb", &[])).await;

        assert_eq!(status, 200);
        assert_eq!(content_type.as_deref(), Some("application/json"));
        assert_eq!(body, json!({ "state": "state", "id": "a/b" }));
    }

    #[tokio::test]
    async fn routes_by_the_path_without_a_resource() {
        let (status, _, body) = answer(request("GET", None, "/orders/order%201", &[])).await;

        assert_eq!(status, 200);
        assert_eq!(body["id"], "order 1");
    }

    #[tokio::test]
    async fn answers_an_unknown_route_with_a_404() {
        let (status, _, body) = answer(request("DELETE", None, "/orders/1", &[])).await;

        assert_eq!(status, 404);
        assert_eq!(
            body,
            json!({
                "statusCode": 404,
                "error": "NotFoundError",
                "message": "Route /orders/1 for method DELETE not found",
            })
        );
    }

    #[tokio::test]
    async fn answers_204_without_a_body_or_content_type() {
        let (status, content_type, body) = answer(request(
            "GET",
            Some("/orders/{id}/lines"),
            "/orders/1/lines",
            &[("page", "x"), ("page", "2")],
        ))
        .await;

        assert_eq!((status, content_type, body), (204, None, Value::Null));
    }

    #[tokio::test]
    async fn reports_every_issue_in_one_422() {
        let (status, _, body) = answer(request(
            "GET",
            Some("/orders/{id}/lines"),
            "/orders/x/lines",
            &[("page", "y")],
        ))
        .await;

        assert_eq!(status, 422);
        assert_eq!(
            body,
            json!({
                "statusCode": 422,
                "error": "RequestValidationError",
                "message": "Validation failed for request",
                "details": { "issues": [
                    { "message": "Expected a number", "path": ["path", "id"] },
                    { "message": "Expected a number", "path": ["query", "page"] },
                ]},
            })
        );
    }

    #[tokio::test]
    async fn answers_http_errors_as_they_are_without_logging() {
        let logs = LogCapture::start();

        let (status, _, body) = answer(request(
            "POST",
            Some("/orders/{id}/lines"),
            "/orders/1/lines",
            &[],
        ))
        .await;

        assert_eq!(status, 400);
        assert_eq!(
            body,
            json!({ "statusCode": 400, "error": "BadRequestError", "message": "Order is closed" })
        );
        assert!(logs.lines().is_empty());
    }

    #[tokio::test]
    async fn logs_other_errors_and_answers_500() {
        let logs = LogCapture::start();

        let (status, _, body) = answer(request("GET", Some("/fail"), "/fail", &[])).await;

        assert_eq!(status, 500);
        assert_eq!(
            body,
            json!({
                "statusCode": 500,
                "error": "InternalServerError",
                "message": "Internal Server Error",
            })
        );
        let lines = logs.lines();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["level"], "ERROR");
        assert_eq!(lines[0]["message"], "Unhandled error");
        assert_eq!(lines[0]["error"], "unable to query: connection reset");
    }
}
