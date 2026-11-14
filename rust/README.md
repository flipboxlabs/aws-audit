# Rust

The Rust port of the internal Lambdas (#93). The CDK constructs stay TypeScript, and consumers never need a Rust toolchain: prebuilt binaries ship in the npm package.

## Layout

```
crates/lambda-kit   Building blocks any Rust Lambda can use, the way the TypeScript
                    Lambdas use Powertools: JSON logging, retry with backoff, a clock
crates/aws-audit    The audit core: model, config, names, table layout, pagination
                    tokens, and the DynamoDB repository, EventBridge publisher and
                    service the Lambdas call
```

## Working on it

```sh
cd rust
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`rust-toolchain.toml` pins the toolchain; rustup installs it on first use.

## Matching the TypeScript SDK

The TypeScript SDK writes the same table, so both must agree exactly. The tests check against the fixtures in [`contract/`](../contract/README.md), which the TypeScript tests record: `crates/aws-audit/tests/contract.rs` covers tokens and the HTTP audit shape, and `crates/aws-audit/tests/replay.rs` replays every SDK fixture through the real AWS SDK clients, asserting each request body, then the result or error. When a behavior changes, change the TypeScript first, run `pnpm contract:update`, then make the Rust tests pass. When the two disagree, fix whichever is wrong, in both if need be, rather than copying a bug.
