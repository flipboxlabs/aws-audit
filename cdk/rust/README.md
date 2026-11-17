# Rust

The Rust port of the internal Lambdas (#93). The CDK constructs stay TypeScript, and consumers never need a Rust toolchain: prebuilt binaries ship in the npm package.

## Layout

```
crates/lambda-kit       Building blocks any Rust Lambda can use, the way the TypeScript
                        Lambdas use Powertools: JSON logging, retry with backoff, a
                        clock, and (the http feature) REST routing, validation and
                        error bodies behind API Gateway
crates/aws-audit        The audit core: model, config, names, table layout, pagination
                        tokens, and the DynamoDB repository, EventBridge publisher and
                        service the Lambdas call
crates/aws-audit-http   What the REST Lambdas share: the pagination query, checks
                        against the configured apps, resource types and statuses, and
                        audit errors as HTTP errors
lambdas/<name>          One binary per Lambda. The directory, package and binary share
                        the name; RustFunctionFactory runs it by that name
lambdas/subscription    The CloudWatch Logs subscription (CloudWatchConstruct)
lambdas/config          GET /config
lambdas/status          GET /status/{status}
```

Each Lambda keeps its handler in `src/lib.rs`, so tests call it directly, and its runtime setup in `src/main.rs`. Tests replay the fixtures through `aws_audit::testing` (the `testing` feature) and check log lines with `lambda_kit::testing::LogCapture`.

A REST Lambda's `src/lib.rs` returns a `lambda_kit::http::Router` of its routes, keyed by API Gateway resource path (`/status/{status}`). A handler collects every invalid input in an `Issues` and returns them as one 422, and maps audit errors with `aws_audit_http::service_error`. Any other error becomes a 500, logged with its causes. Its tests replay `contract/fixtures/http/<route>` through `aws_audit_http::testing`, which builds the API Gateway event each fixture describes, compares the answer, and validates every 200 against `contract/schemas`.

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

The Lambdas read the apps and resource types from `/opt/audit-config.json`, which the config layer (`ConfigLayerConstruct`) writes. `AUDIT_CONFIG_PATH` points elsewhere for local runs.

## Releasing

The workspace lives in the cdk package because the binaries ship in it: release-please counts only commits under `cdk/`, so a Rust change has to be one to release. npm's `files` list keeps the source out of the published package.

## Matching the TypeScript SDK

The TypeScript SDK writes the same table, so both must agree exactly. The tests check against the fixtures in [`contract/`](../../contract/README.md), which the TypeScript tests record: `crates/aws-audit/tests/contract.rs` covers tokens and the HTTP audit shape, and `crates/aws-audit/tests/replay.rs` replays every SDK fixture through the real AWS SDK clients, asserting each request body, then the result or error. When a behavior changes, change the TypeScript first, run `pnpm contract:update`, then make the Rust tests pass. When the two disagree, fix whichever is wrong, in both if need be, rather than copying a bug.
