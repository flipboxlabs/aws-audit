import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import type { CDKConfig } from "../constants.js";
import { AUDIT_CONFIG_LAYER_MODULE_PATH, AUDIT_CONFIG_LAYER_PATH } from "./construct.js";
import { addStandardSettings, functionDefaults, functionEnvironment } from "./function.js";

/**
 * Factory function that creates ESM Node.js Lambda functions with standard configuration.
 *
 * The audit config layer should be passed via the `layers` prop in NodejsFunctionProps.
 *
 * @param config - CDK configuration for environment variables
 * @returns A function that creates configured NodejsFunction instances
 *
 * @internal
 */
export const ESMNodeFunctionFactory =
  (config: CDKConfig) => (scope: Construct, id: string, props: nodejs.NodejsFunctionProps) => {
    const nodejsFunction = new nodejs.NodejsFunction(scope, id, {
      ...functionDefaults(scope, id, props),
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: {
        minify: true,
        metafile: false,
        // Mark audit config layer paths as external so esbuild doesn't try to bundle them
        externalModules: [
          "aws-sdk",
          "@aws-sdk/*",
          AUDIT_CONFIG_LAYER_MODULE_PATH,
          AUDIT_CONFIG_LAYER_PATH,
        ],
        format: nodejs.OutputFormat.ESM,
        platform: "node",
        target: "esnext",
        mainFields: ["module", "main"],
        esbuildArgs: {
          "--conditions": "module",
          "--tree-shaking": "true",
        },
        banner:
          "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
      },
      ...props,
      environment: functionEnvironment(config, props.environment),
    });

    addStandardSettings(config, scope, id, nodejsFunction);

    return nodejsFunction;
  };
