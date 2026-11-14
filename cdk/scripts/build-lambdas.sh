#!/usr/bin/env bash
# Build each Rust Lambda (rust/lambdas/<name>) for arm64 and place its binary at
# assets/lambda/<name>/bootstrap, where RustFunctionFactory packages it from.
#
# Needs cargo-lambda and Zig: cargo-lambda cross-compiles through Zig against an
# old glibc, so the binaries run on provided.al2023 whichever machine builds them.
set -euo pipefail

cdk_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
assets="$cdk_dir/assets/lambda"

shopt -s nullglob
lambdas=("$cdk_dir"/rust/lambdas/*/Cargo.toml)

# Start clean, so a removed Lambda can't linger in the published package
rm -rf "$assets"

if ((${#lambdas[@]} == 0)); then
  echo "No Rust Lambdas under rust/lambdas; nothing to build."
  exit 0
fi

cd "$cdk_dir/rust"
cargo lambda build --release --arm64 --locked --lambda-dir "$assets"

node "$cdk_dir/scripts/check-lambda-assets.mjs"
