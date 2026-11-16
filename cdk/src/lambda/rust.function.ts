import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";
import type { CDKConfig } from "../constants.js";
import { addStandardSettings, functionDefaults, functionEnvironment } from "./function.js";

/**
 * Where the package keeps its prebuilt Rust Lambdas: `<name>/bootstrap` for each
 * binary under `rust/lambdas`. The same two levels up from `src/lambda` and
 * `dist/lambda`.
 *
 * @internal
 */
export const RUST_LAMBDA_ASSETS_DIR = url.fileURLToPath(
  new URL("../../assets/lambda", import.meta.url),
);

/**
 * Overrides {@link RUST_LAMBDA_ASSETS_DIR}, e.g. so tests can use stub binaries.
 *
 * @internal
 */
export const RUST_LAMBDA_ASSETS_VARIABLE = "AWS_AUDIT_RUST_LAMBDA_ASSETS";

/**
 * The directory holding a Rust Lambda's `bootstrap`.
 *
 * @internal
 */
export const rustLambdaAsset = (binary: string): string =>
  path.join(process.env[RUST_LAMBDA_ASSETS_VARIABLE] || RUST_LAMBDA_ASSETS_DIR, binary);

/**
 * A Rust Lambda's props: any function option, plus the binary to run.
 *
 * @internal
 */
export interface RustFunctionProps extends lambda.FunctionOptions {
  /** The binary's name, as built from `rust/lambdas/<binary>`. */
  readonly binary: string;
}

/**
 * Factory function that creates Rust Lambda functions with the same standard
 * configuration as {@link ESMNodeFunctionFactory}, running a prebuilt binary on
 * `provided.al2023`.
 *
 * The audit config layer should be passed via the `layers` prop; Rust Lambdas
 * read it from `/opt/audit-config.json`.
 *
 * @param config - CDK configuration for environment variables
 * @returns A function that creates configured Lambda functions
 *
 * @internal
 */
export const RustFunctionFactory =
  (config: CDKConfig) =>
  (scope: Construct, id: string, { binary, ...props }: RustFunctionProps) => {
    const directory = rustLambdaAsset(binary);

    // Code.fromAsset would package whatever is there, so fail at synth rather than at invoke
    if (!fs.existsSync(path.join(directory, "bootstrap"))) {
      throw new Error(
        `The ${binary} Lambda isn't built: ${path.join(directory, "bootstrap")} is missing. Run \`pnpm build:lambdas\` in the cdk package.`,
      );
    }

    const rustFunction = new lambda.Function(scope, id, {
      ...functionDefaults(scope, id, props),
      ...props,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(directory),
      environment: functionEnvironment(config, props.environment),
    });

    addStandardSettings(config, scope, id, rustFunction);

    return rustFunction;
  };
