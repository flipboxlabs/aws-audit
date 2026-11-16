//! Runs `GET /config` on the Lambda runtime.

use aws_audit::AuditConfig;
use config::{ConfigBody, router, version_from_env};

#[tokio::main]
async fn main() -> Result<(), lambda_kit::http::RuntimeError> {
    lambda_kit::logging::init();

    // A missing config or version fails the init, rather than every request
    let body = ConfigBody::new(&AuditConfig::load()?, version_from_env()?);

    lambda_kit::http::run(router(body)).await
}
