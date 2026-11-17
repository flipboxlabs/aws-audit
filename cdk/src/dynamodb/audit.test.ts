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

const tables = () => synth().findResources("AWS::DynamoDB::Table");

const key = (AttributeName: string, KeyType: "HASH" | "RANGE") => ({ AttributeName, KeyType });

describe("AuditTable", () => {
  it("should create the v2 table under a new logical id, retained on removal", () => {
    expect(Object.keys(tables())).toEqual([
      expect.stringMatching(/^AuditTableAuditTableV2[0-9A-F]{8}$/),
    ]);

    const [table] = Object.values(tables());
    expect(table.DeletionPolicy).toBe("Retain");
    expect(table.UpdateReplacePolicy).toBe("Retain");
    expect(table.Properties).toMatchObject({
      TableName: "DEV-Test-Audit-v2",
      KeySchema: [key("PK", "HASH"), key("SK", "RANGE")],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
    });
    expect(table.Properties).not.toHaveProperty("LocalSecondaryIndexes");
  });

  // The SDK and the Rust Lambdas query these keys and read these projections, and a
  // change replaces the index, so pin the synthesized definitions.
  it("should key and project every listing index", () => {
    const [table] = Object.values(tables());
    const summaryLess = (...keys: string[]) =>
      [
        "id",
        "tenantId",
        "status",
        "tier",
        "operation",
        "message",
        "target",
        "source",
        "rerunable",
        "trace",
        "createdAt",
        "updatedAt",
      ].filter((name) => !keys.includes(name));

    expect(table.Properties.GlobalSecondaryIndexes).toEqual([
      {
        IndexName: "ByType",
        KeySchema: [
          key("tenantKey", "HASH"),
          key("app", "HASH"),
          key("resourceType", "HASH"),
          key("createdAt", "RANGE"),
          key("id", "RANGE"),
        ],
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: summaryLess("createdAt", "id") },
      },
      {
        IndexName: "ByResource",
        KeySchema: [
          key("tenantKey", "HASH"),
          key("app", "HASH"),
          key("resourceType", "HASH"),
          key("resourceId", "HASH"),
          key("createdAt", "RANGE"),
          key("id", "RANGE"),
        ],
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: summaryLess("createdAt", "id") },
      },
      {
        IndexName: "ByStatus",
        KeySchema: [
          key("tenantKey", "HASH"),
          key("status", "HASH"),
          key("kind", "HASH"),
          key("createdAt", "RANGE"),
          key("id", "RANGE"),
        ],
        Projection: {
          ProjectionType: "INCLUDE",
          NonKeyAttributes: summaryLess("status", "createdAt", "id"),
        },
      },
      {
        IndexName: "ByTrace",
        KeySchema: [
          key("tenantKey", "HASH"),
          key("traceId", "HASH"),
          key("traceStage", "RANGE"),
          key("createdAt", "RANGE"),
          key("id", "RANGE"),
        ],
        Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: summaryLess("createdAt", "id") },
      },
    ]);

    expect(table.Properties.AttributeDefinitions).toEqual(
      expect.arrayContaining([
        { AttributeName: "traceStage", AttributeType: "N" },
        { AttributeName: "resourceId", AttributeType: "S" },
      ]),
    );
  });
});
