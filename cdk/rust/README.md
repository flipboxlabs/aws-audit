# Rust

The Rust port of the internal Lambdas (#93), and the `aws-audit` crate apps use to record audits from their own Rust Lambdas. The CDK constructs stay TypeScript, and deploying them never needs a Rust toolchain: prebuilt binaries ship in the npm package.

## Using it in your Lambdas

A Rust Lambda records audits the way a TypeScript one does: it logs each as one JSON line, `{"_audit": {...}}`, and the stack's account-level log subscription (`CloudWatchConstruct`) stores it. The Lambda needs no AWS clients or permissions for that.

The crate isn't on crates.io; depend on it from git, pinned to a release tag:

```toml
[dependencies]
aws-audit = { git = "https://github.com/flipboxlabs/aws-audit", tag = "cdk-v2.0.0" }
```

The default features are only the logging, with no AWS SDK dependencies. Add more as needed:

| Feature   | Adds                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| (default) | `Audits`, `LogAudit`, the model, `AuditConfig`, trace helpers                                               |
| `sqs`     | `aws_audit::sqs`: retry checks, the trace an EventBridge event carries, and `process_batch` for SQS batches |
| `service` | `AuditService`, `AuditRepository` and `AuditEventBus`: reading and writing the audit table and bus directly |

Create an `Audits` per invocation. Audits are checked against the config when added, and written when the buffer is published, when 20 are waiting, and when it's dropped, so an invocation that returns early with `?` still logs them:

```rust
use std::sync::Arc;

use aws_audit::{AuditConfig, Audits, LogAudit, ResourceReference, Status};
use lambda_runtime::{Error, LambdaEvent, service_fn};
use serde_json::Value;

#[tokio::main]
async fn main() -> Result<(), Error> {
    // The apps, each with its resource types, your stack's config lists
    let config = Arc::new(AuditConfig::new([("Orders", ["Order"])]));

    lambda_runtime::run(service_fn(|event: LambdaEvent<Value>| {
        let config = config.clone();
        async move {
            let mut audits = Audits::new(config);
            audits.add(
                LogAudit::new("createOrder", ResourceReference::new("Orders", "Order").with_id("123"))
                    .with_status(Status::Success)
                    .with_message("Order created"),
            )?;
            Ok::<_, Error>(event.payload)
        }
    }))
    .await
}
```

As in TypeScript, an audit without a trace gets the invocation's X-Ray trace id, and `POWERTOOLS_AUDITS_DISABLED` (or `POWERTOOLS_DEV` when that's unset) turns logging off. In the runtime's concurrent mode, where `_X_AMZN_TRACE_ID` isn't set, pass `event.context.xray_trace_id` to `Audits::with_trace_id`.

With the `sqs` feature, `process_batch` handles the messages of an SQS batch concurrently and audits each, as the TypeScript `AuditBatchProcessor` does (so it isn't for FIFO queues, whose messages must be handled in order). Retries of a message share its id, so they're attempts of one audit. A failure is audited with the message's event so it can be rerun, and is reported in the batch response. A rerun sends the event to the audit event bus, unless you name the bus the messages came from with `process_batch_from_bus("PROD-v1-Global", …)`, which records it with the event:

```rust
use aws_audit::sqs::{audit_for, process_batch};
use aws_lambda_events::event::sqs::SqsMessage;

let response = process_batch(
    &mut audits,
    &event.payload,
    |message| audit_for(message, LogAudit::new("processOrder", ResourceReference::new("Orders", "Order"))),
    // The handler can change the audit, e.g. its message or status
    async |message: &SqsMessage, audit: &mut LogAudit| {
        let order = handle(message).await?;
        audit.target.id = Some(order.id.into());
        Ok::<_, anyhow::Error>(())
    },
)
.await;
```

## Layout

```
crates/lambda-kit       Building blocks any Rust Lambda can use, the way the TypeScript
                        Lambdas use Powertools: JSON logging, retry with backoff, a
                        clock, and (the http feature) REST routing, validation and
                        error bodies behind API Gateway
crates/aws-audit        Audit logging for any Rust Lambda (Audits, and with the sqs
                        feature SQS helpers), and the audit core: model, config,
                        names, and with the service feature the table layout,
                        pagination tokens, DynamoDB repository, EventBridge
                        publisher and service the Lambdas call
crates/aws-audit-http   What the REST Lambdas share: the pagination and filter
                        queries, checks against the configured apps, resource types
                        and statuses, and audit errors as HTTP errors
lambdas/<name>          One binary per Lambda. The directory, package and binary share
                        the name; RustFunctionFactory runs it by that name
lambdas/subscription    The CloudWatch Logs subscription (CloudWatchConstruct)
lambdas/config          GET /config
lambdas/status          GET /status/{status}
lambdas/trace           GET /trace/{trace}
lambdas/objects         GET /apps/{app}/objects/{object}[/{item}[/{audit}]]
lambdas/rerun           POST /apps/{app}/objects/{object}/{item}/{audit}/rerun
```

The crate's workspace dependency turns on `service`, so the Lambdas get it. Check that the default features still build alone: `cargo clippy -p aws-audit --lib --no-default-features`; CI does, with and without `sqs`.

Each Lambda keeps its handler in `src/lib.rs`, so tests call it directly, and its runtime setup in `src/main.rs`. Tests replay the fixtures through `aws_audit::testing` (the `testing` feature) and check log lines with `lambda_kit::testing::LogCapture`.

A REST Lambda's `src/lib.rs` returns a `lambda_kit::http::Router` of its routes, keyed by API Gateway resource path (`/status/{status}`). A handler collects every invalid input in an `Issues` and returns them as one 422, and maps audit errors with `aws_audit_http::service_error`. Any other error becomes a 500, logged with its causes. Its tests replay `contract/fixtures/http/<route>` with `aws_audit_http::testing::replay_fixtures`, which builds the API Gateway event each fixture describes, answers the AWS calls from the fixture, compares the calls and the answer, and validates every 200 against `contract/schemas`.

Log fields are camelCase (`resourceType`, `failedEntries`), like the runtime's `requestId` and Powertools' fields.

## Working on it

```sh
cd cdk/rust
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`rust-toolchain.toml` pins the toolchain; rustup installs it on first use.

## Building the Lambdas

The Lambdas run on `provided.al2023` (arm64). From `cdk/`:

```sh
pnpm build:lambdas
```

This writes each binary to `cdk/assets/lambda/<name>/bootstrap` (git-ignored), where `RustFunctionFactory` packages it from, then checks that each one is an arm64 ELF. It needs [cargo-lambda](https://www.cargo-lambda.info) and [Zig](https://ziglang.org): cargo-lambda cross-compiles through Zig against an old glibc, so the binaries run on AL2023 from any build machine. CI runs the same build, and the release workflow runs it before publishing. The cdk package's `prepublishOnly` refuses to publish without the binaries.

Construct tests don't need a build: they point `AWS_AUDIT_RUST_LAMBDA_ASSETS` at stub binaries.

The Lambdas read the apps, each with its resource types, from `/opt/audit-config.json`, which the config layer (`ConfigLayerConstruct`) writes. `AUDIT_CONFIG_PATH` points elsewhere for local runs.

## Releasing

The workspace lives in the cdk package because the binaries ship in it: release-please counts only commits under `cdk/`, so a Rust change has to be one to release. npm's `files` list keeps the source out of the published package.

## Matching the TypeScript SDK

The TypeScript SDK writes the same table and logs, so both must agree exactly. The tests check against the fixtures in [`contract/`](../../contract/README.md): `crates/aws-audit/tests/contract.rs` covers tokens and the HTTP audit shape, `crates/aws-audit/tests/log_lines.rs` checks `Audits` logs what the TypeScript `Audits` logs, `crates/aws-audit/tests/replay.rs` replays every SDK fixture through the real AWS SDK clients, asserting each request body, then the result or error, and each Lambda replays its own fixtures.

The SDK's zod schemas are the source of truth for the audit model; `src/model.rs` is written to match them, not generated. When the model or storage behavior changes (what the SDK also does), change the TypeScript first, run `pnpm contract:update`, then make the Rust tests pass. Request validation has no schema: the Rust code in `aws-audit-http` is its source of truth, pinned by the 422 HTTP fixtures. The HTTP and subscription fixtures belong to the Lambdas, which are only in Rust now: change those fixtures by hand along with the Rust code. When the two implementations disagree, fix whichever is wrong, in both if need be, rather than copying a bug.
