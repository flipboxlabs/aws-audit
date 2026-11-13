import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vite-plus/test";

import AuditTable from "./audit.js";

const synth = () => {
  const stack = new cdk.Stack(new cdk.App(), "TestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  new AuditTable(stack, "AuditTable", {
    config: {
      env: "dev",
      service: "Test",
      aws: { account: "123456789012", region: "us-east-1" },
    },
  });

  return Template.fromStack(stack);
};

const LISTING = ["operation", "status", "message", "source", "target", "rerunable", "createdAt"];

describe("AuditTable", () => {
  // The SDK reads parent audits with the same projection (DynamoDB.Projections.LISTING), and a
  // projection change replaces the index, so pin the synthesized attributes.
  it("should project the listing attributes into the listing indexes", () => {
    const [table] = Object.values(synth().findResources("AWS::DynamoDB::Table"));
    const projections = Object.fromEntries(
      (
        table.Properties.GlobalSecondaryIndexes as Array<{
          IndexName: string;
          Projection: unknown;
        }>
      ).map(({ IndexName, Projection }) => [IndexName, Projection]),
    );

    expect(projections).toEqual({
      GSI1_SN: { ProjectionType: "INCLUDE", NonKeyAttributes: LISTING },
      GSI1_SS: {
        ProjectionType: "INCLUDE",
        NonKeyAttributes: [...LISTING, "GSI1_SN_PK", "GSI1_SN_SK"],
      },
      GSI2_SS: { ProjectionType: "INCLUDE", NonKeyAttributes: LISTING },
    });
  });
});
