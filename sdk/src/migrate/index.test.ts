import {
  ConditionalCheckFailedException,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
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
 * A client whose scan returns `pages`, whose reads find the items on them (or in
 * `v2`, for the v2 table), and whose writes `reject` can refuse with a failed
 * condition.
 */
const stubClient = (
  pages: Record<string, unknown>[][],
  reject: (command: PutItemCommand | UpdateItemCommand) => boolean = () => false,
  v2: Record<string, unknown>[] = [],
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
    if (command instanceof GetItemCommand) {
      const { PK, SK } = unmarshall(command.input.Key!);
      const items = command.input.TableName === TO ? v2 : pages.flat();
      const item = items.find((item) => item.PK === PK && item.SK === SK);
      return { Item: item && marshall(item, { removeUndefinedValues: true }) };
    }
    if (command instanceof QueryCommand) {
      const { ":pk": PK } = unmarshall(command.input.ExpressionAttributeValues!);
      const copies = v2.filter((item) => item.PK === PK && String(item.SK).startsWith("related#"));
      return { Items: copies.map(({ PK, SK }) => marshall({ PK, SK })) };
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
      PK: "-#App1#Order#audit-1",
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
      scopes: new Set(["App1", "App1#Order", "*#Order", "App1#Order#order-1"]),
    });
    expect(report).toEqual({
      scanned: 1,
      audits: { written: 1, existing: 0, merged: 0 },
      copies: { written: 0, existing: 0, ownTarget: 0 },
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
      PK: "tenant-1#App1#Order#audit-1",
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
      PK: "-#App1#Order#audit-1",
      SK: "related#TestApp#User#user-1",
      id: "audit-1",
      status: "fail",
      tier: 2,
      operation: "createOrder",
      target: { app: "TestApp", type: "User", id: "user-1" },
      source: { app: "App1", type: "Order", id: "order-1" },
      rerunable: true,
      related: true,
      trace: "trace-1:2",
      createdAt: NOW,
      updatedAt: NOW,
      tenantKey: "-",
      app: "TestApp",
      resourceType: "User",
      resourceId: "user-1",
      ttl: 1775099045,
    });

    // After every audit is written, whichever page it was on
    const [update] = commands(send, UpdateItemCommand);
    expect(send.mock.calls.at(-1)?.[0]).toBe(update);
    expect(update.input).toMatchObject({
      TableName: TO,
      Key: marshall({ PK: "-#App1#Order#audit-1", SK: "audit" }),
      UpdateExpression: "ADD #scopes :scopes",
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#scopes": "scopes", "#pk": "PK" },
    });
    expect(unmarshall(update.input.ExpressionAttributeValues!)).toEqual({
      ":scopes": new Set(["TestApp", "TestApp#User", "*#User", "TestApp#User#user-1"]),
    });
    expect(report).toMatchObject({
      scanned: 2,
      audits: { written: 1, existing: 0 },
      copies: { written: 1, existing: 0 },
      scopes: { updated: 1, missingAudit: 0 },
    });
  });

  it("gives a copy its audit's createdAt, which the earlier table didn't keep on it", async () => {
    const EARLIER = "2026-01-01T00:00:00.000Z";
    const { client, send } = stubClient([
      [
        v1Copy({ createdAt: NOW }),
        v1Copy({
          SK: "audit-1#TestApp.Order#order-9",
          target: { app: "TestApp", type: "Order", id: "order-9" },
        }),
        v1Copy({ tenantId: "tenant-a", createdAt: NOW }),
        v1Copy({ SK: "audit-2#TestApp.User#user-1", createdAt: NOW }),
      ],
      [
        v1Audit({ createdAt: EARLIER }),
        v1Audit({
          PK: "tenant-a#App1.Order",
          tenantId: "tenant-a",
          createdAt: "2025-06-01T00:00:00.000Z",
        }),
      ],
    ]);

    await migrate({ client, from: FROM, to: TO });

    const copies = putItems(send).filter(({ SK }) => SK !== "audit");
    expect(copies.map(({ PK, createdAt }) => [PK, createdAt])).toEqual([
      ["-#App1#Order#audit-1", EARLIER],
      ["-#App1#Order#audit-1", EARLIER],
      ["tenant-a#App1#Order#audit-1", "2025-06-01T00:00:00.000Z"],
      // Without its audit, a copy keeps its own
      ["-#App1#Order#audit-2", NOW],
    ]);
    // Read from the earlier table, once per audit
    expect(
      commands(send, GetItemCommand).map(({ input }) => [input.TableName, unmarshall(input.Key!)]),
    ).toEqual([
      [FROM, { PK: "App1.Order", SK: "audit-1" }],
      [FROM, { PK: "tenant-a#App1.Order", SK: "audit-1" }],
      [FROM, { PK: "App1.Order", SK: "audit-2" }],
    ]);
  });

  it("writes createdAt and updatedAt with milliseconds, and leaves out NULLs", async () => {
    const { client, send } = stubClient([
      [
        v1Copy({ createdAt: "2026-01-01T00:00:00Z" }),
        v1Audit({
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T03:04:05.6Z",
          tenantId: null,
          message: null,
        }),
      ],
    ]);

    await migrate({ client, from: FROM, to: TO });

    const copy = putItems(send).find(({ SK }) => SK !== "audit");
    const audit = putItems(send).find(({ SK }) => SK === "audit");
    expect(copy).toMatchObject({ createdAt: "2026-01-01T00:00:00.000Z", updatedAt: NOW });
    expect(audit).toMatchObject({
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T03:04:05.600Z",
    });
    expect(audit).not.toHaveProperty("tenantId");
    expect(audit).not.toHaveProperty("message");
  });

  describe("an audit retried since the deploy", () => {
    const EARLIER = "2026-01-01T00:00:00.000Z";
    const v2Audit = (overrides: Record<string, unknown> = {}) => ({
      PK: "-#App1#Order#audit-1",
      SK: "audit",
      attempts: [{ number: 1, status: "success", at: NOW }],
      createdAt: NOW,
      ...overrides,
    });
    const v2Copy = { PK: "-#App1#Order#audit-1", SK: "related#TestApp#User#user-1" };
    const isAuditPut = (command: PutItemCommand | UpdateItemCommand) =>
      command instanceof PutItemCommand && unmarshall(command.input.Item!).SK === "audit";

    it("gets the earlier attempts first and the earlier createdAt, as do its copies", async () => {
      const { client, send } = stubClient([[v1Audit({ createdAt: EARLIER })]], isAuditPut, [
        v2Audit(),
        v2Copy,
      ]);

      const report = await migrate({ client, from: FROM, to: TO });

      const updates = commands(send, UpdateItemCommand).map(({ input }) => ({
        key: unmarshall(input.Key!),
        expression: input.UpdateExpression,
        condition: input.ConditionExpression,
        values: unmarshall(input.ExpressionAttributeValues!),
      }));
      const moved = {
        key: v2Copy,
        expression: "SET #createdAt = :createdAt",
        condition: "attribute_exists(#pk)",
        values: { ":createdAt": EARLIER },
      };
      expect(updates).toEqual([
        moved,
        {
          key: { PK: "-#App1#Order#audit-1", SK: "audit" },
          expression: "SET #attempts = :attempts, #createdAt = :createdAt",
          condition: "#createdAt = :current AND size(#attempts) = :count",
          values: {
            ":attempts": [
              { number: 1, status: "fail", error: "Boom", at: NOW },
              { number: 2, status: "success", at: NOW },
            ],
            ":createdAt": EARLIER,
            ":current": NOW,
            ":count": 1,
          },
        },
        moved,
      ]);
      expect(report.audits).toEqual({ written: 0, existing: 0, merged: 1 });
    });

    it("merges again when an upsert changed it meanwhile", async () => {
      let refused = 0;
      const { client, send } = stubClient(
        [[v1Audit({ createdAt: EARLIER })]],
        (command) =>
          isAuditPut(command) ||
          (command instanceof UpdateItemCommand &&
            command.input.ConditionExpression?.startsWith("#createdAt") === true &&
            refused++ === 0),
        [v2Audit()],
      );

      const report = await migrate({ client, from: FROM, to: TO });

      expect(
        commands(send, UpdateItemCommand).filter(({ input }) =>
          input.UpdateExpression?.startsWith("SET #attempts"),
        ),
      ).toHaveLength(2);
      expect(report.audits).toMatchObject({ merged: 1 });
    });

    it("is left alone once it has the earlier createdAt", async () => {
      const { client, send } = stubClient([[v1Audit({ createdAt: EARLIER })]], isAuditPut, [
        v2Audit({ createdAt: EARLIER }),
        v2Copy,
      ]);

      const report = await migrate({ client, from: FROM, to: TO });

      expect(commands(send, UpdateItemCommand)).toEqual([]);
      expect(report.audits).toEqual({ written: 0, existing: 1, merged: 0 });
    });
  });

  it("leaves out a copy under its audit's own target", async () => {
    const { client, send } = stubClient([
      [
        v1Copy({
          PK: "App1.Order",
          SK: "audit-1#App1.Order#order-1",
          target: { app: "App1", type: "Order", id: "order-1" },
        }),
        v1Audit(),
      ],
    ]);

    const report = await migrate({ client, from: FROM, to: TO });

    expect(report).toMatchObject({
      audits: { written: 1 },
      copies: { written: 0, ownTarget: 1 },
      scopes: { updated: 0 },
      invalid: [],
    });
    expect(putItems(send).map(({ SK }) => SK)).toEqual(["audit"]);
  });

  it("writes an audit whose id holds a # as an audit", async () => {
    const { client, send } = stubClient([
      [
        v1Audit({ SK: "batch#7", id: "batch#7" }),
        v1Audit({ SK: "a#App1.Order#order-1#x", id: "a#App1.Order#order-1#x" }),
      ],
    ]);

    const report = await migrate({ client, from: FROM, to: TO });

    expect(report).toMatchObject({ audits: { written: 2 }, copies: { written: 0 }, invalid: [] });
    expect(putItems(send).map(({ PK, SK }) => [PK, SK])).toEqual([
      ["-#App1#Order#batch%237", "audit"],
      ["-#App1#Order#a%23App1.Order%23order-1%23x", "audit"],
    ]);
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
        reason: "A related resource's copy needs a source",
      },
    ]);
    expect(putItems(send).map(({ PK }) => PK)).toEqual(["-#App1#Order#audit-1"]);
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

    expect(
      send.mock.calls.every(
        ([command]) => command instanceof ScanCommand || command instanceof GetItemCommand,
      ),
    ).toBe(true);
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
