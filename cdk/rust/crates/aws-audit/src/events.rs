//! Publishing audit events to EventBridge (`AuditEventBus` and
//! `BatchHandler.putEventsWithRetry` in the TypeScript SDK).

use std::sync::Arc;

use aws_sdk_eventbridge::Client;
use aws_sdk_eventbridge::types::{PutEventsRequestEntry, PutEventsResultEntry};
use lambda_kit::retry::{Backoff, Jitter, RandomJitter};
use serde_json::json;

use crate::js;
use crate::model::EventBridgeEvent;
use crate::upsert::UpsertAudit;

/// The source of audit events.
pub const SOURCE: &str = "Audit";

/// The detail type of the event sent after an audit is stored.
pub const UPSERTED: &str = "Upserted";

/// Entries per `PutEvents` request (EventBridge's limit).
const CHUNK_SIZE: usize = 10;

/// Entry error codes worth resending.
const RETRYABLE_ERROR_CODES: [&str; 4] = [
    "InternalException",
    "InternalFailure",
    "ServiceUnavailable",
    "ThrottlingException",
];

/// Not every event was accepted.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PutEventsError {
    /// What happened.
    pub message: String,
    /// The result entries that carry an error code.
    pub failed_entries: Vec<PutEventsResultEntry>,
    /// Every result entry received.
    pub results: Vec<PutEventsResultEntry>,
    /// The last failed `PutEvents` call, when one failed. Boxed, as SDK errors
    /// are large.
    #[source]
    pub cause: Option<Box<aws_sdk_eventbridge::Error>>,
}

/// Publishes audit events.
#[derive(Debug, Clone)]
pub struct AuditEventBus {
    client: Client,
    bus_name: String,
    backoff: Backoff,
    jitter: Arc<dyn Jitter>,
}

impl AuditEventBus {
    /// A bus publishing to `bus_name`, making 3 attempts per entry.
    pub fn new(client: Client, bus_name: impl Into<String>) -> Self {
        AuditEventBus {
            client,
            bus_name: bus_name.into(),
            backoff: Backoff::default(),
            jitter: Arc::new(RandomJitter),
        }
    }

    /// Uses `jitter` for retry delays.
    pub fn with_jitter(mut self, jitter: Arc<dyn Jitter>) -> Self {
        self.jitter = jitter;
        self
    }

    /// The bus events go to.
    pub fn bus_name(&self) -> &str {
        &self.bus_name
    }

    /// Sends an `Upserted` event for each audit, whose detail is `{"audit": …}`.
    pub async fn upserted(
        &self,
        audits: &[UpsertAudit],
    ) -> Result<Vec<PutEventsResultEntry>, PutEventsError> {
        let entries = audits
            .iter()
            .map(|audit| {
                let detail = serde_json::to_value(audit).map_or_else(
                    |_| String::from("{}"),
                    |audit| js::stringify(&json!({ "audit": audit })),
                );
                PutEventsRequestEntry::builder()
                    .event_bus_name(&self.bus_name)
                    .detail(detail)
                    .detail_type(UPSERTED)
                    .source(SOURCE)
                    .build()
            })
            .collect();

        self.put_events_with_retry(entries).await
    }

    /// Sends an audit's recorded event again, to `bus` (a name or ARN), in one
    /// `PutEvents` without retries (`putEventsOrThrow` in the TypeScript rerun
    /// handler): a rerun answers its caller, who can retry. The detail is sent as
    /// stored, byte for byte, and left out when there's none. `resources` are the
    /// entry's `Resources`, left out when empty: a rerun names its audit there.
    ///
    /// Fails when the call fails, or the entry comes back rejected or not at all.
    pub async fn resend(
        &self,
        bus: &str,
        event: &EventBridgeEvent,
        resources: Vec<String>,
    ) -> Result<PutEventsResultEntry, PutEventsError> {
        let entry = PutEventsRequestEntry::builder()
            .set_source(event.source.clone())
            .event_bus_name(bus)
            .set_detail(event.detail.clone())
            .set_detail_type(event.detail_type.clone())
            .set_resources((!resources.is_empty()).then_some(resources))
            .build();

        let output = self
            .client
            .put_events()
            .entries(entry)
            .send()
            .await
            .map_err(|error| PutEventsError {
                message: "PutEvents failed".to_owned(),
                failed_entries: Vec::new(),
                results: Vec::new(),
                cause: Some(Box::new(error.into())),
            })?;

        match output.entries().first() {
            Some(result) if result.error_code().is_none() => Ok(result.clone()),
            result => Err(PutEventsError {
                message: "EventBridge accepted 0 of 1 events after 1 attempt".to_owned(),
                failed_entries: result.cloned().into_iter().collect(),
                results: output.entries().to_vec(),
                cause: None,
            }),
        }
    }

    /// Sends entries, 10 per `PutEvents`. Entries rejected with a retryable code
    /// (throttling, internal failure) are resent after a jittered backoff until
    /// accepted or attempts run out. A call that fails isn't resent, since it may
    /// have published before failing; nor is an entry without a result.
    ///
    /// Results line up with `entries`, less any without a result.
    pub async fn put_events_with_retry(
        &self,
        entries: Vec<PutEventsRequestEntry>,
    ) -> Result<Vec<PutEventsResultEntry>, PutEventsError> {
        let mut results: Vec<Option<PutEventsResultEntry>> = vec![None; entries.len()];
        let mut pending: Vec<usize> = (0..entries.len()).collect();
        let mut cause = None;
        let mut attempt = 1;

        loop {
            let mut retry = Vec::new();
            for indexes in pending.chunks(CHUNK_SIZE) {
                let output = match self
                    .client
                    .put_events()
                    .set_entries(Some(
                        indexes
                            .iter()
                            .map(|&index| entries[index].clone())
                            .collect(),
                    ))
                    .send()
                    .await
                {
                    Ok(output) => output,
                    Err(error) => {
                        cause = Some(Box::new(aws_sdk_eventbridge::Error::from(error)));
                        continue;
                    }
                };

                for (position, &index) in indexes.iter().enumerate() {
                    let Some(entry) = output.entries().get(position) else {
                        continue;
                    };
                    if entry
                        .error_code()
                        .is_some_and(|code| RETRYABLE_ERROR_CODES.contains(&code))
                    {
                        retry.push(index);
                    }
                    results[index] = Some(entry.clone());
                }
            }

            if retry.is_empty() || !self.backoff.should_retry(attempt) {
                break;
            }

            let delay = self.backoff.delay(attempt, self.jitter.sample());
            tracing::warn!(
                count = retry.len(),
                attempt,
                delayMs = delay.as_millis() as u64,
                "Retrying event bridge events"
            );
            tokio::time::sleep(delay).await;
            pending = retry;
            attempt += 1;
        }

        let returned: Vec<PutEventsResultEntry> = results.into_iter().flatten().collect();
        let failed_entries: Vec<PutEventsResultEntry> = returned
            .iter()
            .filter(|entry| entry.error_code().is_some())
            .cloned()
            .collect();
        let accepted = returned.len() - failed_entries.len();

        if accepted != entries.len() {
            return Err(PutEventsError {
                message: format!(
                    "EventBridge accepted {accepted} of {} events after {attempt} {}",
                    entries.len(),
                    if attempt == 1 { "attempt" } else { "attempts" }
                ),
                failed_entries,
                results: returned,
                cause,
            });
        }

        tracing::debug!(count = returned.len(), "Pushed event bridge events");
        Ok(returned)
    }
}
