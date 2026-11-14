/**
 * Points RustFunctionFactory at stub binaries, one per Lambda under
 * `rust/lambdas`, so construct tests synthesize without a Rust build.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUST_LAMBDA_ASSETS_VARIABLE } from "./lambda/rust.function.js";

const lambdasDir = path.resolve(import.meta.dirname, "../rust/lambdas");

if (!process.env[RUST_LAMBDA_ASSETS_VARIABLE]) {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "rust-lambda-stubs-"));
  const lambdas = fs.existsSync(lambdasDir) ? fs.readdirSync(lambdasDir) : [];

  for (const name of lambdas) {
    fs.mkdirSync(path.join(assets, name));
    fs.writeFileSync(path.join(assets, name, "bootstrap"), "stub");
  }

  process.env[RUST_LAMBDA_ASSETS_VARIABLE] = assets;
}
