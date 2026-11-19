import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { describe, expect, it } from "vite-plus/test";
import type { CDKConfig } from "../constants.js";
import { ConfigLayerConstruct } from "../lambda/construct.js";
import { RestApiConstruct } from "./construct.js";

const config: CDKConfig = {
  env: "test",
  aws: { account: "123456789012", region: "us-east-1" },
  service: "Audit",
};

const SHARED_BUS_ARN = "arn:aws:events:us-east-1:210987654321:event-bus/TEST-Shared";

const synth = (rerunEventBuses?: (stack: cdk.Stack) => events.IEventBus[]) => {
  const stack = new cdk.Stack(new cdk.App(), "TestStack", {
    env: { account: config.aws.account, region: config.aws.region },
  });
  const table = new dynamodb.TableV2(stack, "Table", {
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
  });
  const eventBus = new events.EventBus(stack, "Bus");
  const layer = new ConfigLayerConstruct(stack, "AuditConfigLayer", {
    apps: { App1: ["Order"] },
  });

  new RestApiConstruct(stack, "RestAPI", {
    config,
    table,
    eventBus,
    rerunEventBuses: rerunEventBuses?.(stack),
    lambda: { layers: [layer.layer] },
  });

  return Template.fromStack(stack);
};

// The rerun Lambda's RERUN_EVENT_BUSES and the buses its policy lets it put events on
const rerunBuses = (template: Template) => {
  const [rerun] = Object.values(
    template.findResources("AWS::Lambda::Function", {
      Properties: {
        Environment: { Variables: { POWERTOOLS_SERVICE_NAME: "ResourceRerun" } },
      },
    }),
  );
  const [policy] = Object.values(
    template.findResources("AWS::IAM::Policy", {
      Properties: {
        Roles: [{ Ref: Match.stringLikeRegexp("ReRunNodeFunction") }],
      },
    }),
  );
  const putEvents = policy.Properties.PolicyDocument.Statement.filter(
    (statement: { Action: unknown }) => statement.Action === "events:PutEvents",
  ).map((statement: { Resource: unknown }) => statement.Resource);

  return { variable: rerun.Properties.Environment.Variables.RERUN_EVENT_BUSES, putEvents };
};

describe("RestApiConstruct", () => {
  it("should let a rerun send to the audit event bus only by default", () => {
    const { variable, putEvents } = rerunBuses(synth());
    const auditBus = { "Fn::GetAtt": [expect.stringMatching(/^Bus/), "Arn"] };

    expect(variable).toEqual(auditBus);
    expect(putEvents).toEqual([auditBus]);
  });

  it("should let a rerun send to the rerun event buses too", () => {
    const { variable, putEvents } = rerunBuses(
      synth((stack) => [
        events.EventBus.fromEventBusName(stack, "Global", "TEST-Global"),
        events.EventBus.fromEventBusArn(stack, "Shared", SHARED_BUS_ARN),
      ]),
    );

    // The audit bus, then each rerun bus, comma-separated
    expect(variable).toEqual({
      "Fn::Join": [
        "",
        [
          { "Fn::GetAtt": [expect.stringMatching(/^Bus/), "Arn"] },
          ",arn:",
          { Ref: "AWS::Partition" },
          `:events:us-east-1:123456789012:event-bus/TEST-Global,${SHARED_BUS_ARN}`,
        ],
      ],
    });
    expect(putEvents).toEqual([
      { "Fn::GetAtt": [expect.stringMatching(/^Bus/), "Arn"] },
      {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":events:us-east-1:123456789012:event-bus/TEST-Global",
          ],
        ],
      },
      SHARED_BUS_ARN,
    ]);
  });
});
