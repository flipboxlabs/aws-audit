//! Building blocks for AWS Lambda functions in Rust.
//!
//! These cover what Powertools gives the TypeScript Lambdas, so each function
//! doesn't solve them again:
//!
//! - [`logging`]: structured JSON logs through `tracing`, level and message first.
//! - [`retry`]: exponential backoff with jitter, for retrying throttled AWS calls.
//! - [`clock`]: an injectable clock, so time-dependent code is testable.
//! - [`testing`]: capturing those logs in tests.
//! - `http` (the `http` feature): REST handlers behind API Gateway, with routing,
//!   validation and error bodies.

pub mod clock;
#[cfg(feature = "http")]
pub mod http;
pub mod logging;
pub mod retry;
pub mod testing;
