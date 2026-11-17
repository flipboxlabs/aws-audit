import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vite-plus/test";
import Objects from "./construct.js";

const LAYER_ARN = "arn:aws:lambda:us-east-1:123456789012:layer:AuditConfig:1";

const synth = () => {
  const stack = new cdk.Stack(new cdk.App(), "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const table = new dynamodb.TableV2(stack, "Table", {
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
  });

  new Objects(stack, "Objects", {
    config: { env: "dev", service: "Test", aws: { account: "123456789012", region: "us-east-1" } },
    table,
    eventBus: new events.EventBus(stack, "Bus"),
    lambda: {
      layers: [lambda.LayerVersion.fromLayerVersionArn(stack, "AuditConfigLayer", LAYER_ARN)],
    },
    restApi: { resource: new apigateway.RestApi(stack, "RestApi").root },
  });

  return Template.fromStack(stack);
};

/** Each policy's statements, keyed by the policy's logical id */
const statements = (template: Template) =>
  Object.fromEntries(
    Object.entries(template.findResources("AWS::IAM::Policy")).map(([id, policy]) => [
      id,
      JSON.stringify(policy.Properties.PolicyDocument.Statement),
    ]),
  );

describe("Objects construct", () => {
  it("should run the objects and rerun Rust binaries with the config layer", () => {
    const template = synth();

    for (const [name, service] of [
      ["DEV-REST-API-Test-Resources", "Resource"],
      ["DEV-REST-API-Test-Resource-Rerun", "ResourceRerun"],
    ]) {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: name,
        Runtime: "provided.al2023",
        Handler: "bootstrap",
        Architectures: ["arm64"],
        Layers: Match.arrayWith([LAYER_ARN]),
        Environment: { Variables: Match.objectLike({ POWERTOOLS_SERVICE_NAME: service }) },
      });
    }
  });

  it("should keep the functions' logical ids, so the named functions update in place", () => {
    const template = synth();
    const id = (name: string) =>
      Object.keys(
        template.findResources("AWS::Lambda::Function", { Properties: { FunctionName: name } }),
      );

    // The ids the Node functions had: .../NodeFunction/Resource
    expect(id("DEV-REST-API-Test-Resources")).toEqual(["ObjectsNodeFunction45BF3B37"]);
    expect(id("DEV-REST-API-Test-Resource-Rerun")).toEqual(["ObjectsReRunNodeFunction56F7CDB8"]);
  });

  it("should let the objects Lambda only read the table", () => {
    const [policy] = Object.entries(statements(synth())).filter(([id]) =>
      id.startsWith("ObjectsNodeFunction"),
    );

    expect(policy[1]).toMatch(/dynamodb:GetItem/);
    expect(policy[1]).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/);
    expect(policy[1]).not.toMatch(/events:/);
  });

  it("should let the rerun Lambda read the table and put events, and nothing else", () => {
    const [policy] = Object.entries(statements(synth())).filter(([id]) =>
      id.startsWith("ObjectsReRunNodeFunction"),
    );

    expect(policy[1]).toMatch(/dynamodb:GetItem/);
    expect(policy[1]).toMatch(/events:PutEvents/);
    expect(policy[1]).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/);
  });

  it("should add the object, item, audit and rerun methods, each requiring an API key", () => {
    const template = synth();

    for (const [method, operation] of [
      ["GET", "List audit object items"],
      ["GET", "List audit items for resource"],
      ["GET", "Get audit item detail"],
      ["POST", "Rerun the event"],
    ]) {
      template.hasResourceProperties("AWS::ApiGateway::Method", {
        HttpMethod: method,
        ApiKeyRequired: true,
        OperationName: operation,
      });
    }
  });
});
