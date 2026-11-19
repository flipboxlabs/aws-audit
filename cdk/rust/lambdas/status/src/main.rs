//! Runs `GET /status/{status}` on the Lambda runtime.

use std::sync::Arc;

use aws_audit::AuditConfig;
use aws_audit::names::resource_names_from_env;
use aws_audit::service::AuditService;
use aws_audit::storage::AuditRepository;
use status::{State, router};

#[tokio::main]
async fn main() -> Result<(), lambda_kit::http::RuntimeError> {
    lambda_kit::logging::init();

    // A missing config or ENVIRONMENT fails the init, rather than every request
    let config = Arc::new(AuditConfig::load()?);
    let names = resource_names_from_env()?;

    let aws = aws_config::load_from_env().await;
    let storage = AuditRepository::new(aws_sdk_dynamodb::Client::new(&aws), &names.table, &config);
    // Listing publishes nothing, so there's no event bus
    let service = AuditService::new(config.clone(), storage, None);

    lambda_kit::http::run(router(State { config, service })).await
}
