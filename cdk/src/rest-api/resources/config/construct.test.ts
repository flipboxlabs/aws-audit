import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it, vi } from "vitest";

// Swap the bundled NodejsFunction for an inline one so synth doesn't run esbuild
vi.mock("../../../lambda/nodejs.function.js", () => ({
  ESMNodeFunctionFactory:
    () =>
    (
      scope: cdk.Stack,
      id: string,
      props: { functionName?: string; layers?: lambda.ILayerVersion[] },
    ) =>
      new lambda.Function(scope, id, {
        functionName: props.functionName,
        layers: props.layers,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("export const handler = async () => {};"),
      }),
}));

import Config from "./construct.js";

const LAYER_ARN = "arn:aws:lambda:us-east-1:123456789012:layer:AuditConfig:1";

const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
);

const synth = () => {
  const stack = new cdk.Stack(new cdk.App(), "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const restApi = new apigateway.RestApi(stack, "RestApi");

  new Config(stack, "Config", {
    config: {
      env: "dev",
      service: "Test",
      aws: { account: "123456789012", region: "us-east-1" },
    },
    lambda: {
      layers: [lambda.LayerVersion.fromLayerVersionArn(stack, "AuditConfigLayer", LAYER_ARN)],
    },
    restApi: { resource: restApi.root },
  });

  return Template.fromStack(stack);
};

describe("Config construct", () => {
  it("should name the Lambda after the environment and service", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "DEV-REST-API-Test-Config",
    });
  });

  it("should attach the audit config layer to the Lambda", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Layers: Match.arrayWith([LAYER_ARN]),
    });
  });

  it("should pass the CDK package version to the Lambda", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ AWS_AUDIT_CDK_VERSION: PACKAGE_VERSION }),
      },
    });
  });

  it("should add a GET /config method that requires an API key", () => {
    const template = synth();

    template.hasResourceProperties("AWS::ApiGateway::Resource", {
      PathPart: "config",
    });
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ApiKeyRequired: true,
      OperationName: "Retrieve audit configuration",
    });
  });

  it("should not grant DynamoDB or EventBridge access", () => {
    const policies = synth().findResources("AWS::IAM::Policy");
    const actions = JSON.stringify(
      Object.values(policies).map((policy) => policy.Properties.PolicyDocument.Statement),
    );

    expect(actions).not.toMatch(/dynamodb:/);
    expect(actions).not.toMatch(/events:/);
  });
});
