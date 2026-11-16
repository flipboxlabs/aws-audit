import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { describe, expect, it } from "vite-plus/test";
import type { CDKConfig } from "../constants.js";
import { ConfigLayerConstruct } from "../lambda/construct.js";
import { CloudWatchConstruct } from "./construct.js";

const config: CDKConfig = {
  env: "test",
  aws: { account: "123456789012", region: "us-east-1" },
  service: "Audit",
};

const synth = () => {
  const stack = new cdk.Stack(new cdk.App(), "TestStack", {
    env: { account: config.aws.account, region: config.aws.region },
  });
  const table = new dynamodb.TableV2(stack, "Table", {
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
  });
  const eventBus = new events.EventBus(stack, "Bus");
  const layer = new ConfigLayerConstruct(stack, "AuditConfigLayer", {
    apps: ["App1"],
    resourceTypes: ["Order"],
  });

  new CloudWatchConstruct(stack, "CloudWatch", {
    config,
    table,
    eventBus,
    lambda: { layers: [layer.layer] },
  });

  return Template.fromStack(stack);
};

describe("CloudWatchConstruct", () => {
  it("should run the subscription as the Rust binary with the config layer", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "TEST-Account-CloudWatch-Subscription",
      Runtime: "provided.al2023",
      Handler: "bootstrap",
      Architectures: ["arm64"],
      Layers: Match.arrayWith([{ Ref: Match.stringLikeRegexp("AuditConfigLayer") }]),
      Environment: {
        Variables: Match.objectLike({ ENVIRONMENT: "test", SERVICE: "Audit" }),
      },
    });
  });

  it("should retry failed invocations twice", () => {
    synth().hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 2,
    });
  });

  it("should send audit lines from every other log group to the subscription", () => {
    const template = synth();

    template.hasResourceProperties("AWS::Lambda::Permission", {
      Principal: "logs.amazonaws.com",
      Action: "lambda:InvokeFunction",
    });

    const [policy] = Object.values(template.findResources("AWS::Logs::AccountPolicy"));
    expect(policy.Properties.PolicyType).toBe("SUBSCRIPTION_FILTER_POLICY");
    // The document is a Fn::Join around the function's ARN, so match its text
    expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain(
      JSON.stringify('"FilterPattern":"{ $._audit.operation = * }"').slice(1, -1),
    );
  });
});
