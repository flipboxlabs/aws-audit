//! The CloudWatch Logs subscription Lambda (`subscription.handler.ts`): stores the
//! audits apps log.
//!
//! An app logs an audit as one JSON line, `{"_audit": {...}}`. The account-level
//! subscription filter sends those lines here, and each audit is upserted through
//! [`AuditService::upsert_item`].
//!
//! Every log line stands alone. A line without an audit is skipped; an audit that
//! fails validation or can't be stored is logged. The invocation never fails: a
//! retried batch would add another attempt to every audit already stored.

use aws_audit::service::AuditService;
use aws_audit::upsert::UpsertAudit;
use aws_lambda_events::event::cloudwatch_logs::{LogData, LogEntry};
use futures_util::StreamExt;
use futures_util::stream;
use lambda_kit::logging::ErrorChain;
use serde_json::Value;

/// The key an audit is logged under (`AUDIT_LOG_IDENTIFIER` in the TypeScript SDK).
pub const AUDIT_LOG_IDENTIFIER: &str = "_audit";

/// How many audits are stored at once.
const CONCURRENCY: usize = 32;

/// Stores the audits in a batch of log lines.
pub async fn handle(service: &AuditService, logs: &LogData) {
    // CloudWatch checks a new subscription's destination with a control message;
    // it holds no audits
    if logs.message_type != "DATA_MESSAGE" {
        tracing::debug!(
            messageType = logs.message_type,
            "Skipping a CloudWatch Logs control message"
        );
        return;
    }

    stream::iter(&logs.log_events)
        .for_each_concurrent(CONCURRENCY, |entry| store(service, entry))
        .await;
}

/// The audit logged on a line, if it holds one.
fn audit_from(message: &str) -> Option<Value> {
    match serde_json::from_str(message).ok()? {
        Value::Object(mut line) => line
            .remove(AUDIT_LOG_IDENTIFIER)
            .filter(|audit| !audit.is_null()),
        _ => None,
    }
}

async fn store(service: &AuditService, entry: &LogEntry) {
    let Some(audit) = audit_from(&entry.message) else {
        tracing::warn!(
            logEventId = entry.id,
            logMessage = entry.message,
            "No audit log identifier found in message"
        );
        return;
    };

    let audit: UpsertAudit = match serde_json::from_value(audit) {
        Ok(audit) => audit,
        Err(error) => {
            tracing::error!(
                logEventId = entry.id,
                error = %ErrorChain(&error),
                "An error was caught trying to save audit item"
            );
            return;
        }
    };

    let id = audit.id.clone();
    let app = audit.target.app.clone();
    let resource_type = audit.target.resource_type.clone();
    tracing::info!(
        id,
        app,
        resourceType = resource_type,
        "Storing audit to DynamoDB"
    );

    match service.upsert_item(audit).await {
        Ok(()) => tracing::info!(
            id,
            app,
            resourceType = resource_type,
            "Stored audit to DynamoDB"
        ),
        Err(error) => tracing::error!(
            logEventId = entry.id,
            id,
            app,
            resourceType = resource_type,
            error = %ErrorChain(&error),
            "An error was caught trying to save audit item"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_audit_on_a_line() {
        assert_eq!(
            audit_from(r#"{"_audit":{"operation":"createOrder"}}"#),
            Some(serde_json::json!({ "operation": "createOrder" }))
        );
    }

    #[test]
    fn skips_lines_without_an_audit() {
        for message in [
            "START RequestId: 8f507cfc Version: $LATEST",
            r#"{"level":"INFO","message":"Order created"}"#,
            r#"{"_audit":null}"#,
            "null",
            "[]",
            "",
        ] {
            assert_eq!(audit_from(message), None, "{message}");
        }
    }
}
