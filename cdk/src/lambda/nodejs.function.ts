import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { CDKConfig } from "../constants.js";
import { AUDIT_CONFIG_LAYER_PATH } from "./construct.js";

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
      tracing: lambda.Tracing.ACTIVE,
      timeout: props.timeout || cdk.Duration.seconds(10),
      logRetention: props.logRetention || logs.RetentionDays.ONE_WEEK,
      memorySize: props.memorySize || 512,
      architecture: props.architecture || lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: {
        minify: true,
        metafile: false,
        // Mark audit config layer path as external so esbuild doesn't try to bundle it
        externalModules: ["aws-sdk", "@aws-sdk/*", AUDIT_CONFIG_LAYER_PATH],
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
      role:
        props.role ||
        new iam.Role(scope, `${id}-FunctionRole`, {
          assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
          ],
        }),
      ...props,
      environment: {
        ...props.environment,
        ENVIRONMENT: config.env,
        AWS_ACCOUNT: config.aws.account,
        POWERTOOLS_LOG_LEVEL: "WARN",
      },
    });

    if (config.service) {
      nodejsFunction.addEnvironment("SERVICE", config.service);
    }

    // Add Lambda Insights layer
    nodejsFunction.addLayers(
      lambda.LayerVersion.fromLayerVersionArn(
        scope,
        `${id}InsightLayer`,
        `arn:aws:lambda:${
          cdk.Stack.of(scope).region
        }:580247275435:layer:LambdaInsightsExtension-Arm64:2`,
      ),
    );

    return nodejsFunction;
  };
