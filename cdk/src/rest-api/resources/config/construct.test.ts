import { readFileSync } from "node:fs";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vite-plus/test";
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

  it("should run the config Rust binary", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "provided.al2023",
      Handler: "bootstrap",
      Architectures: ["arm64"],
      Environment: {
        Variables: Match.objectLike({ POWERTOOLS_SERVICE_NAME: "Config" }),
      },
    });
  });

  it("should keep the function's logical id, so the named function updates in place", () => {
    const functions = synth().findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: "DEV-REST-API-Test-Config" },
    });

    // The id the Node function had: Config/NodeFunction/Resource
    expect(Object.keys(functions)).toEqual(["ConfigNodeFunction21A90E6B"]);
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
