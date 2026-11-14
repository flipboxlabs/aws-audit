import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import type { CDKConfig } from "../constants.js";

/**
 * Settings every audit Lambda gets unless its props override them: arm64, 512 MB,
 * a 10 s timeout, active X-Ray tracing, one-week log retention and a role with
 * basic execution rights.
 *
 * @internal
 */
export const functionDefaults = (scope: Construct, id: string, props: lambda.FunctionOptions) => ({
  tracing: lambda.Tracing.ACTIVE,
  timeout: props.timeout || cdk.Duration.seconds(10),
  logRetention: props.logRetention || logs.RetentionDays.ONE_WEEK,
  memorySize: props.memorySize || 512,
  architecture: props.architecture || lambda.Architecture.ARM_64,
  role:
    props.role ||
    new iam.Role(scope, `${id}-FunctionRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    }),
});

/**
 * Environment every audit Lambda gets, on top of its own.
 *
 * @internal
 */
export const functionEnvironment = (config: CDKConfig, environment?: Record<string, string>) => ({
  ...environment,
  ENVIRONMENT: config.env,
  AWS_ACCOUNT: config.aws.account,
  POWERTOOLS_LOG_LEVEL: "WARN",
});

/**
 * Adds the `SERVICE` variable (when configured) and the Lambda Insights layer.
 *
 * @internal
 */
export const addStandardSettings = (
  config: CDKConfig,
  scope: Construct,
  id: string,
  fn: lambda.Function,
) => {
  if (config.service) {
    fn.addEnvironment("SERVICE", config.service);
  }

  // Add Lambda Insights layer
  fn.addLayers(
    lambda.LayerVersion.fromLayerVersionArn(
      scope,
      `${id}InsightLayer`,
      `arn:aws:lambda:${
        cdk.Stack.of(scope).region
      }:580247275435:layer:LambdaInsightsExtension-Arm64:2`,
    ),
  );
};
