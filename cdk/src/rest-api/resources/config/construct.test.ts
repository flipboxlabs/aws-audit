import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it, vi } from "vitest";

// Swap the bundled NodejsFunction for an inline one so synth doesn't run esbuild
vi.mock("../../../lambda/nodejs.function.js", () => ({
  ESMNodeFunctionFactory:
    () => (scope: cdk.Stack, id: string, props: { functionName?: string; layers?: unknown[] }) =>
      new lambda.Function(scope, id, {
        functionName: props.functionName,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("export const handler = async () => {};"),
      }),
}));

import Config from "./construct.js";

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
    lambda: { layers: [] },
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
