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

const synth = (
  rerunEventBuses?: (stack: cdk.Stack) => events.IEventBus[],
  defaultRerunEventBus?: (stack: cdk.Stack) => events.IEventBus,
) => {
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
    defaultRerunEventBus: defaultRerunEventBus?.(stack),
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

  const variables = rerun.Properties.Environment.Variables;
  return {
    variable: variables.RERUN_EVENT_BUSES,
    account: variables.RERUN_EVENT_BUS_ACCOUNT,
    defaultBus: variables.RERUN_DEFAULT_EVENT_BUS,
    putEvents,
  };
};

describe("RestApiConstruct", () => {
  it("should let a rerun send to the audit event bus only by default", () => {
    const { variable, account, defaultBus, putEvents } = rerunBuses(synth());
    const auditBus = { "Fn::GetAtt": [expect.stringMatching(/^Bus/), "Arn"] };

    expect(variable).toEqual(auditBus);
    // The stack's, which a bus recorded by name is in
    expect(account).toBe("123456789012");
    expect(putEvents).toEqual([auditBus]);
    // An event that recorded no bus goes to the audit bus
    expect(defaultBus).toBeUndefined();
  });

  it("should send an event that recorded no bus to the default rerun event bus", () => {
    const { variable, defaultBus, putEvents } = rerunBuses(
      synth(undefined, (stack) => events.EventBus.fromEventBusArn(stack, "Shared", SHARED_BUS_ARN)),
    );
    const auditBus = { "Fn::GetAtt": [expect.stringMatching(/^Bus/), "Arn"] };

    expect(defaultBus).toBe(SHARED_BUS_ARN);
    // An event may still record it, or the audit bus
    expect(variable).toEqual({ "Fn::Join": ["", [auditBus, `,${SHARED_BUS_ARN}`]] });
    expect(putEvents).toEqual([auditBus, SHARED_BUS_ARN]);
  });

  it("should refuse a default rerun event bus in another region", () => {
    expect(() =>
      synth(undefined, (stack) =>
        events.EventBus.fromEventBusArn(
          stack,
          "Elsewhere",
          "arn:aws:events:eu-west-1:123456789012:event-bus/TEST-Global",
        ),
      ),
    ).toThrow(/is in eu-west-1, not the stack's region us-east-1/);
  });

  it("should refuse a rerun event bus in another region", () => {
    expect(() =>
      synth((stack) => [
        events.EventBus.fromEventBusArn(
          stack,
          "Elsewhere",
          "arn:aws:events:eu-west-1:123456789012:event-bus/TEST-Global",
        ),
      ]),
    ).toThrow(/is in eu-west-1, not the stack's region us-east-1/);
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
