//! Runs the subscription on the Lambda runtime.

use std::sync::Arc;

use aws_audit::AuditConfig;
use aws_audit::events::AuditEventBus;
use aws_audit::names::resource_names_from_env;
use aws_audit::service::AuditService;
use aws_audit::storage::AuditRepository;
use aws_lambda_events::event::cloudwatch_logs::LogsEvent;
use lambda_runtime::{Error, LambdaEvent, service_fn};

#[tokio::main]
async fn main() -> Result<(), Error> {
    lambda_kit::logging::init();

    // A missing config or ENVIRONMENT fails the init, so no audit is dropped quietly
    let config = Arc::new(AuditConfig::load()?);
    let names = resource_names_from_env()?;

    let aws = aws_config::load_from_env().await;
    let storage = AuditRepository::new(aws_sdk_dynamodb::Client::new(&aws), &names.table, &config);
    let events = AuditEventBus::new(aws_sdk_eventbridge::Client::new(&aws), &names.event_bus);
    let service = AuditService::new(config, storage, Some(events));

    lambda_runtime::run(service_fn(|event: LambdaEvent<LogsEvent>| {
        let service = &service;
        async move {
            subscription::handle(service, &event.payload.aws_logs.data).await;
            Ok::<(), Error>(())
        }
    }))
    .await
}
