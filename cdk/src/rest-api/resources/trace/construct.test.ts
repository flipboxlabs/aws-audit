import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vite-plus/test";
import Trace from "./construct.js";

const LAYER_ARN = "arn:aws:lambda:us-east-1:123456789012:layer:AuditConfig:1";

const synth = () => {
  const stack = new cdk.Stack(new cdk.App(), "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const table = new dynamodb.TableV2(stack, "Table", {
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
  });

  new Trace(stack, "Trace", {
    config: { env: "dev", service: "Test", aws: { account: "123456789012", region: "us-east-1" } },
    table,
    lambda: {
      layers: [lambda.LayerVersion.fromLayerVersionArn(stack, "AuditConfigLayer", LAYER_ARN)],
    },
    restApi: { resource: new apigateway.RestApi(stack, "RestApi").root },
  });

  return Template.fromStack(stack);
};

describe("Trace construct", () => {
  it("should run the trace Rust binary with the config layer", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "DEV-REST-API-Test-Trace",
      Runtime: "provided.al2023",
      Handler: "bootstrap",
      Architectures: ["arm64"],
      Layers: Match.arrayWith([LAYER_ARN]),
      Environment: { Variables: Match.objectLike({ POWERTOOLS_SERVICE_NAME: "Trace" }) },
    });
  });

  it("should keep the function's logical id, so the named function updates in place", () => {
    const functions = synth().findResources("AWS::Lambda::Function", {
      Properties: { FunctionName: "DEV-REST-API-Test-Trace" },
    });

    // The id the Node function had: Trace/NodeFunction/Resource
    expect(Object.keys(functions)).toEqual(["TraceNodeFunction4340906B"]);
  });

  it("should only read the table", () => {
    const actions = JSON.stringify(
      Object.values(synth().findResources("AWS::IAM::Policy")).map(
        (policy) => policy.Properties.PolicyDocument.Statement,
      ),
    );

    expect(actions).toMatch(/dynamodb:Query/);
    expect(actions).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/);
    expect(actions).not.toMatch(/events:/);
  });

  it("should add a GET /trace/{trace} method that requires an API key", () => {
    const template = synth();

    template.hasResourceProperties("AWS::ApiGateway::Resource", { PathPart: "{trace}" });
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: "GET",
      ApiKeyRequired: true,
      OperationName: "Retrieve items by trace identifier",
    });
  });
});
