import {
  ConditionalCheckFailedException,
  type DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vite-plus/test";
import { migrate } from "./index.js";

const FROM = "TEST-Audit";
const TO = "TEST-Audit-v2";
const NOW = "2026-01-02T03:04:05.678Z";

/** An audit as the earlier table stored it */
const v1Audit = (overrides: Record<string, unknown> = {}) => ({
  PK: "App1.Order",
  SK: "audit-1",
  id: "audit-1",
  operation: "createOrder",
  status: "fail",
  tier: 2,
  target: { app: "App1", type: "Order", id: "order-1" },
  context: { attempt: 2 },
  event: { source: "orders", "detail-type": "OrderCreated", detail: "{}" },
  error: "Boom",
  attempts: [{ number: 1, status: "fail", error: "Boom", at: NOW }],
  trace: "trace-1:2",
  createdAt: NOW,
  updatedAt: NOW,
  LSI1_N_SK: 21767323445678,
  GSI1_SS_PK: "App1.Order#order-1",
  GSI1_SS_SK: "audit-1",
  GSI1_SN_PK: "trace-1",
  GSI1_SN_SK: 2,
  GSI2_SS_PK: "fail",
  GSI2_SS_SK: `${NOW}#audit-1`,
  ttl: 1775099045,
  ...overrides,
});

/** A related resource's copy of `audit-1`, as the earlier table stored it */
const v1Copy = (overrides: Record<string, unknown> = {}) =>
  v1Audit({
    PK: "TestApp.User",
    SK: "audit-1#TestApp.User#user-1",
    id: "audit-1#TestApp.User#user-1",
    target: { app: "TestApp", type: "User", id: "user-1" },
    source: { app: "App1", type: "Order", id: "order-1" },
    rerunable: true,
    event: undefined,
    error: undefined,
    attempts: undefined,
    GSI1_SS_PK: "TestApp.User#user-1",
    GSI1_SS_SK: "audit-1#TestApp.User#user-1",
    ...overrides,
  });

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });

/**
 * A client whose scan returns `pages`, and whose writes `reject` can refuse with a
 * failed condition.
 */
const stubClient = (
  pages: Record<string, unknown>[][],
  reject: (command: PutItemCommand | UpdateItemCommand) => boolean = () => false,
) => {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof ScanCommand) {
      const page = command.input.ExclusiveStartKey
        ? Number(unmarshall(command.input.ExclusiveStartKey).page)
        : 0;
      return {
        Items: pages[page].map((item) => marshall(item, { removeUndefinedValues: true })),
        LastEvaluatedKey: page + 1 < pages.length ? marshall({ page: page + 1 }) : undefined,
      };
    }
    if (reject(command as PutItemCommand | UpdateItemCommand)) {
      throw conditionFailed();
    }
    return {};
  });

  return { client: { send } as unknown as DynamoDBClient, send };
};

const commands = <T>(send: ReturnType<typeof vi.fn>, type: new (...args: never[]) => T): T[] =>
  send.mock.calls.map(([command]) => command).filter((command) => command instanceof type);

const putItems = (send: ReturnType<typeof vi.fn>) =>
  commands(send, PutItemCommand).map((command) => unmarshall(command.input.Item!));

describe("migrate", () => {
  it("writes an audit under its v2 key with its index attributes, without the earlier keys", async () => {
    const { client, send } = stubClient([[v1Audit()]]);

    const report = await migrate({ client, from: FROM, to: TO });

    const [put] = commands(send, PutItemCommand);
    expect(put.input).toMatchObject({
      TableName: TO,
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "PK" },
    });
    expect(unmarshall(put.input.Item!)).toEqual({
      PK: "App1.Order#audit-1",
      SK: "audit",
      id: "audit-1",
      operation: "createOrder",
      status: "fail",
      tier: 2,
      target: { app: "App1", type: "Order", id: "order-1" },
      context: { attempt: 2 },
      event: { source: "orders", "detail-type": "OrderCreated", detail: "{}" },
      error: "Boom",
      attempts: [{ number: 1, status: "fail", error: "Boom", at: NOW }],
      trace: "trace-1:2",
      createdAt: NOW,
      updatedAt: NOW,
      ttl: 1775099045,
      tenantKey: "-",
      app: "App1",
      resourceType: "Order",
      resourceId: "order-1",
      kind: "audit",
      traceId: "trace-1",
      traceStage: 2,
      scopes: new Set(["App1", "App1.Order", "*.Order", "App1.Order#order-1"]),
    });
    expect(report).toEqual({
      scanned: 1,
      audits: { written: 1, existing: 0 },
      copies: { written: 0, existing: 0 },
      scopes: { updated: 0, missingAudit: 0 },
      invalid: [],
    });
  });

  it("rebuilds a trace kept only in the earlier trace keys, without the tenant", async () => {
    const { client, send } = stubClient([
      [
        v1Audit({
          PK: "tenant-1#App1.Order",
          tenantId: "tenant-1",
          trace: undefined,
          GSI1_SN_PK: "tenant-1#trace-1",
          GSI1_SN_SK: 0,
        }),
        v1Audit({ SK: "audit-2", id: "audit-2", trace: null }),
      ],
    ]);

    await migrate({ client, from: FROM, to: TO });

    const [tenant, nullTrace] = putItems(send);
    expect(tenant).toMatchObject({
      PK: "tenant-1#App1.Order#audit-1",
      trace: "trace-1",
      tenantKey: "tenant-1",
      traceId: "trace-1",
      traceStage: 0,
    });
    // A NULL trace beside trace keys is rebuilt from them too
    expect(nullTrace).toMatchObject({ trace: "trace-1:2", traceId: "trace-1" });
  });

  it("writes a copy as a summary in its audit's partition and adds its scopes to the audit", async () => {
    const { client, send } = stubClient([[v1Copy()], [v1Audit()]]);

    const report = await migrate({ client, from: FROM, to: TO });

    const [copy] = putItems(send);
    expect(copy).toEqual({
      PK: "App1.Order#audit-1",
      SK: "related#TestApp.User#user-1",
      id: "audit-1",
      status: "fail",
      tier: 2,
      operation: "createOrder",
      target: { app: "TestApp", type: "User", id: "user-1" },
      source: { app: "App1", type: "Order", id: "order-1" },
      rerunable: true,
      trace: "trace-1:2",
      createdAt: NOW,
      updatedAt: NOW,
      tenantKey: "-",
      app: "TestApp",
      resourceType: "User",
      resourceId: "user-1",
      kind: "related",
      ttl: 1775099045,
    });

    // After every audit is written, whichever page it was on
    const [update] = commands(send, UpdateItemCommand);
    expect(send.mock.calls.at(-1)?.[0]).toBe(update);
    expect(update.input).toMatchObject({
      TableName: TO,
      Key: marshall({ PK: "App1.Order#audit-1", SK: "audit" }),
      UpdateExpression: "ADD #scopes :scopes",
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#scopes": "scopes", "#pk": "PK" },
    });
    expect(unmarshall(update.input.ExpressionAttributeValues!)).toEqual({
      ":scopes": new Set(["TestApp", "TestApp.User", "*.User", "TestApp.User#user-1"]),
    });
    expect(report).toMatchObject({
      scanned: 2,
      audits: { written: 1, existing: 0 },
      copies: { written: 1, existing: 0 },
      scopes: { updated: 1, missingAudit: 0 },
    });
  });

  it("leaves items already in the v2 table, and counts copies whose audit is missing", async () => {
    const { client } = stubClient([[v1Audit(), v1Copy()]], () => true);

    const report = await migrate({ client, from: FROM, to: TO });

    expect(report).toMatchObject({
      audits: { written: 0, existing: 1 },
      copies: { written: 0, existing: 1 },
      scopes: { updated: 0, missingAudit: 1 },
    });
  });

  it("rethrows other write failures", async () => {
    const { client, send } = stubClient([[v1Audit()]]);
    send.mockImplementationOnce(async () => ({
      Items: [marshall(v1Audit())],
      LastEvaluatedKey: undefined,
    }));
    send.mockRejectedValueOnce(new Error("AccessDenied"));

    await expect(migrate({ client, from: FROM, to: TO })).rejects.toThrow("AccessDenied");
  });

  it("reports items that aren't valid audits or copies, and copies the rest", async () => {
    const { client, send } = stubClient([
      [
        v1Audit({ SK: "audit-2", id: "audit-2", operation: undefined }),
        v1Audit({ SK: "audit-3", id: "audit-3", createdAt: undefined, updatedAt: undefined }),
        v1Copy({ source: undefined }),
        v1Audit(),
      ],
    ]);

    const report = await migrate({ client, from: FROM, to: TO });

    expect(report.audits.written).toBe(1);
    expect(report.invalid).toEqual([
      { PK: "App1.Order", SK: "audit-2", reason: expect.any(String) },
      { PK: "App1.Order", SK: "audit-3", reason: "An audit needs a createdAt or updatedAt" },
      {
        PK: "TestApp.User",
        SK: "audit-1#TestApp.User#user-1",
        reason: "A related resource's copy needs its audit id, an identified target and a source",
      },
    ]);
    expect(putItems(send).map(({ PK }) => PK)).toEqual(["App1.Order#audit-1"]);
  });

  it("defaults the tier, and takes createdAt from updatedAt, when an earlier audit left them out", async () => {
    const { client, send } = stubClient([[v1Audit({ tier: undefined, createdAt: undefined })]]);

    const report = await migrate({ client, from: FROM, to: TO });

    expect(report.invalid).toEqual([]);
    expect(putItems(send)[0]).toMatchObject({ tier: 2, createdAt: NOW });
  });

  it("only reads on a dry run", async () => {
    const { client, send } = stubClient([[v1Audit(), v1Copy()]]);

    const report = await migrate({ client, from: FROM, to: TO, dryRun: true });

    expect(send.mock.calls.every(([command]) => command instanceof ScanCommand)).toBe(true);
    expect(report).toMatchObject({
      audits: { written: 1 },
      copies: { written: 1 },
      scopes: { updated: 1 },
    });
  });

  it("scans every page and reports progress after each", async () => {
    const pages = [[v1Audit()], [v1Audit({ SK: "audit-2", id: "audit-2" })]];
    const { client, send } = stubClient(pages);
    const onProgress = vi.fn();

    const report = await migrate({ client, from: FROM, to: TO, onProgress });

    const scans = commands(send, ScanCommand);
    expect(scans.map((scan) => scan.input.TableName)).toEqual([FROM, FROM]);
    expect(scans[1].input.ExclusiveStartKey).toEqual(marshall({ page: 1 }));
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(report.audits.written).toBe(2);
  });
});
