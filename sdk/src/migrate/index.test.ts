import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { relatedSortKey } from "../repository.js";
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

/** Items as the released SDKs stored them, written by `fixtures/generate.mjs` */
const released = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(new URL("fixtures/v1.json", import.meta.url), "utf8")) as Record<
      string,
      Parameters<typeof unmarshall>[0][]
    >,
  ).map(([version, items]) => [version, items.map((item) => unmarshall(item))]),
);

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });

/**
 * A client whose scan returns `pages`, whose reads find the items on them (or in
 * the v2 table, which starts as `v2`), and whose writes `reject` can refuse with a
 * failed condition. The v2 table keeps the writes, checking the conditions on keys
 * and revisions the migration sets; a merge's own condition is left to `reject`.
 */
const stubClient = (
  pages: Record<string, unknown>[][],
  reject: (command: PutItemCommand | UpdateItemCommand) => boolean = () => false,
  v2: Record<string, unknown>[] = [],
) => {
  const table = v2.map((item) => structuredClone(item));
  const find = (key: Record<string, unknown>) =>
    table.find((item) => item.PK === key.PK && item.SK === key.SK);
  const holds = (
    condition: string | undefined,
    item: Record<string, unknown> | undefined,
    values: Record<string, unknown>,
  ) => {
    switch (condition) {
      case "attribute_not_exists(#pk)":
        return !item;
      case "attribute_exists(#pk)":
        return !!item;
      case "attribute_exists(#pk) AND (attribute_not_exists(#revision) OR #revision <= :revision)":
        return (
          !!item &&
          (item.revision === undefined || Number(item.revision) <= Number(values[":revision"]))
        );
      default:
        return true;
    }
  };

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
      const key = unmarshall(command.input.Key!);
      const item =
        command.input.TableName === TO
          ? find(key)
          : pages.flat().find(({ PK, SK }) => PK === key.PK && SK === key.SK);
      return { Item: item && marshall(item, { removeUndefinedValues: true }) };
    }
    if (command instanceof QueryCommand) {
      const { ":pk": PK } = unmarshall(command.input.ExpressionAttributeValues!);
      const copies = table.filter(
        (item) => item.PK === PK && String(item.SK).startsWith("related#"),
      );
      return { Items: copies.map(({ target }) => marshall({ target })) };
    }
    if (reject(command as PutItemCommand | UpdateItemCommand)) {
      throw conditionFailed();
    }

    const { input } = command as PutItemCommand | UpdateItemCommand | DeleteItemCommand;
    const values = input.ExpressionAttributeValues
      ? unmarshall(input.ExpressionAttributeValues)
      : {};
    const key = unmarshall("Item" in input ? input.Item! : input.Key!);
    const item = find(key);
    if (!holds(input.ConditionExpression, item, values)) {
      throw conditionFailed();
    }
    if (command instanceof PutItemCommand) {
      table.splice(item ? table.indexOf(item) : table.length, item ? 1 : 0, key);
      return {};
    }
    if (command instanceof DeleteItemCommand) {
      if (item) table.splice(table.indexOf(item), 1);
      return {};
    }

    // SET #name = :value, … and ADD #name :set
    const names = (command as UpdateItemCommand).input.ExpressionAttributeNames!;
    const [set = "", add] = String((command as UpdateItemCommand).input.UpdateExpression)
      .replace(/^SET /, "")
      .split("ADD ");
    const updated = item!;
    for (const clause of set.split(", ").filter(Boolean)) {
      const [name, value] = clause.trim().split(" = ");
      updated[names[name]] = values[value];
    }
    if (add) {
      const [name, value] = add.trim().split(" ");
      updated[names[name]] = new Set([
        ...((updated[names[name]] as Set<string>) ?? []),
        ...(values[value] as Set<string>),
      ]);
    }
    return { Attributes: marshall(updated, { removeUndefinedValues: true }) };
  });

  return { client: { send } as unknown as DynamoDBClient, send, table };
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
      rerunable: true,
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
      migrated: true,
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
    // A NULL trace was an empty one, which cleared the trace; the keys beside it were left over
    expect(nullTrace).toMatchObject({ trace: "" });
    expect(nullTrace).not.toHaveProperty("traceId");
    expect(nullTrace).not.toHaveProperty("traceStage");
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

    // After every audit is written, whichever page it was on, then its copies from it
    const [update] = commands(send, UpdateItemCommand);
    const calls = send.mock.calls.map(([command]) => command);
    expect(calls.slice(calls.indexOf(update))).toEqual([
      update,
      expect.any(QueryCommand),
      expect.any(PutItemCommand),
    ]);
    expect(update.input).toMatchObject({
      TableName: TO,
      Key: marshall({ PK: "-#App1#Order#audit-1", SK: "audit" }),
      UpdateExpression: "ADD #scopes :scopes",
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#scopes": "scopes", "#pk": "PK" },
      ReturnValues: "ALL_NEW",
    });
    expect(unmarshall(update.input.ExpressionAttributeValues!)).toEqual({
      ":scopes": new Set(["TestApp", "TestApp#User", "*#User", "TestApp#User#user-1"]),
    });
    expect((calls.at(-2) as QueryCommand).input.ConsistentRead).toBe(true);
    expect(unmarshall((calls.at(-1) as PutItemCommand).input.Item!)).toEqual({
      ...copy,
      revision: 1,
    });
    expect(report).toMatchObject({
      scanned: 2,
      audits: { written: 1, existing: 0 },
      copies: { written: 1, existing: 0 },
      scopes: { updated: 1, missingAudit: 0 },
    });
  });

  it("says a copy is rerunable as its audit is, whatever the earlier SDK stored on it", async () => {
    const migrated = async (audit: Record<string, unknown>) => {
      const { client, send } = stubClient([[v1Copy({ rerunable: false })], [v1Audit(audit)]]);
      await migrate({ client, from: FROM, to: TO });
      const [copy] = putItems(send);
      return copy.rerunable;
    };

    // A failure with an event, without a flag, as the earlier SDK logged one
    expect(await migrated({})).toBe(true);
    expect(await migrated({ status: "success" })).toBe(false);
    expect(await migrated({ rerunable: false })).toBe(false);
    expect(await migrated({ event: undefined })).toBe(false);
  });

  it("puts each copy again from its audit, with its createdAt, which the earlier table didn't keep on it", async () => {
    const EARLIER = "2026-01-01T00:00:00.000Z";
    const { client, table } = stubClient([
      [
        v1Copy({ createdAt: NOW }),
        v1Copy({
          SK: "audit-1#TestApp.Order#order-9",
          target: { app: "TestApp", type: "Order", id: "order-9" },
        }),
        v1Copy({ tenantId: "tenant-a", createdAt: NOW }),
      ],
      [
        v1Audit({ createdAt: EARLIER, message: "Order failed" }),
        v1Audit({
          PK: "tenant-a#App1.Order",
          tenantId: "tenant-a",
          createdAt: "2025-06-01T00:00:00.000Z",
        }),
      ],
    ]);

    await migrate({ client, from: FROM, to: TO });

    const copies = table.filter(({ related }) => related);
    expect(copies.map(({ PK, createdAt, message }) => [PK, createdAt, message])).toEqual([
      ["-#App1#Order#audit-1", EARLIER, "Order failed"],
      ["-#App1#Order#audit-1", EARLIER, "Order failed"],
      ["tenant-a#App1#Order#audit-1", "2025-06-01T00:00:00.000Z", undefined],
    ]);
  });

  describe("a copy written before SDK 1.4.2", () => {
    /** It kept its audit's target, as its source too; only its SK names its resource */
    const v1LegacyCopy = (overrides: Record<string, unknown> = {}) =>
      v1Copy({
        PK: "App1.Order",
        target: { app: "App1", type: "Order", id: "order-1" },
        source: { app: "App1", type: "Order", id: "order-1" },
        GSI1_SS_PK: "App1.Order#order-1",
        ...overrides,
      });

    it("is written as a copy under the resource its SK names", async () => {
      const { client, send } = stubClient([[v1Audit(), v1LegacyCopy()]]);

      const report = await migrate({ client, from: FROM, to: TO });

      expect(report).toMatchObject({
        audits: { written: 1 },
        copies: { written: 1 },
        invalid: [],
      });
      const copy = putItems(send).find(({ SK }) => SK !== "audit");
      expect(copy).toMatchObject({
        PK: "-#App1#Order#audit-1",
        SK: "related#TestApp#User#user-1",
        id: "audit-1",
        target: { app: "TestApp", type: "User", id: "user-1" },
        source: { app: "App1", type: "Order", id: "order-1" },
        related: true,
        app: "TestApp",
        resourceType: "User",
        resourceId: "user-1",
      });
      const scopes = commands(send, UpdateItemCommand).map(({ input }) =>
        unmarshall(input.ExpressionAttributeValues!),
      );
      expect(scopes).toEqual([
        { ":scopes": new Set(["TestApp", "TestApp#User", "*#User", "TestApp#User#user-1"]) },
      ]);
    });

    it("keeps its resource id as its SK holds it, as text", async () => {
      const { client, send } = stubClient([
        [v1LegacyCopy({ SK: "audit-1#TestApp.Order#7" }), v1Audit()],
      ]);

      await migrate({ client, from: FROM, to: TO });

      expect(putItems(send).find(({ related }) => related)).toMatchObject({
        SK: "related#TestApp#Order#7",
        target: { app: "TestApp", type: "Order", id: "7" },
      });
    });

    it("takes the split of its SK whose audit id names an audit in its partition", async () => {
      const { client, send } = stubClient([
        [v1LegacyCopy({ SK: "audit-1#TestApp.User#x#TestApp.User#1" }), v1Audit()],
      ]);

      const report = await migrate({ client, from: FROM, to: TO });

      expect(report.invalid).toEqual([]);
      expect(putItems(send).find(({ related }) => related)).toMatchObject({
        PK: "-#App1#Order#audit-1",
        id: "audit-1",
        target: { app: "TestApp", type: "User", id: "x#TestApp.User#1" },
      });
      expect(
        commands(send, GetItemCommand)
          .slice(0, 2)
          .map(({ input }) => [input.TableName, unmarshall(input.Key!)]),
      ).toEqual([
        [FROM, { PK: "App1.Order", SK: "audit-1" }],
        [FROM, { PK: "App1.Order", SK: "audit-1#TestApp.User#x" }],
      ]);
    });

    it("is reported when its SK names no audit, or it has no source", async () => {
      const { client, send } = stubClient([
        [
          v1LegacyCopy({ SK: "audit-1#TestApp-User#user-1" }),
          v1LegacyCopy({ SK: "audit-1#TestApp.User#user-1", source: undefined }),
          v1LegacyCopy({ SK: "audit-9#TestApp.User#x#TestApp.User#1" }),
        ],
      ]);

      const report = await migrate({ client, from: FROM, to: TO });

      const neither =
        "An item without attempts, which isn't an audit, whose SK names neither its target nor a resource after an audit's id";
      expect(report.invalid).toEqual([
        { PK: "App1.Order", SK: "audit-1#TestApp-User#user-1", reason: neither },
        {
          PK: "App1.Order",
          SK: "audit-1#TestApp.User#user-1",
          reason: "A related resource's copy needs a source",
        },
        {
          PK: "App1.Order",
          SK: "audit-9#TestApp.User#x#TestApp.User#1",
          reason: "A related resource's copy whose SK names no audit in the earlier table",
        },
      ]);
      expect(putItems(send)).toEqual([]);
    });
  });

  describe("items as the released SDKs stored them", () => {
    it("writes SDK 1.8.0's audit whose trace has no id, listed under no trace, on a dry run too", async () => {
      for (const dryRun of [true, false]) {
        const { client, table } = stubClient([released["1.8.0"]]);

        const report = await migrate({ client, from: FROM, to: TO, dryRun });

        expect(report.invalid).toEqual([]);
        if (dryRun) continue;
        const audit = table.find(({ id }) => id === "traced");
        expect(audit).toMatchObject({ PK: "acme#Jobs#Job#traced", trace: ":1" });
        // An index key can't be empty
        expect(audit).not.toHaveProperty("traceId");
        expect(audit).not.toHaveProperty("traceStage");
      }
    });

    it("writes SDK 1.4.1's copies under the resources their SKs name, refusing those without one audit", async () => {
      const { client, table } = stubClient([released["1.4.1"]]);

      const report = await migrate({ client, from: FROM, to: TO });

      expect(report).toMatchObject({
        scanned: 12,
        audits: { written: 7 },
        copies: { written: 3, ownTarget: 0 },
        invalid: [
          {
            PK: "Jobs.Job",
            SK: "a#CRM.Contact#7#CRM.Contact#8",
            reason: "A related resource's copy whose SK reads as more than one audit's",
          },
          // Written for an audit without a given id, whose generated id it doesn't hold
          {
            PK: "Jobs.Job",
            SK: "undefined#CRM.Contact#9",
            reason: "A related resource's copy whose SK names no audit in the earlier table",
          },
        ],
      });
      const copies = table.filter(({ related }) => related);
      expect(copies.map(({ id, SK, target, source }) => ({ id, SK, target, source }))).toEqual([
        {
          id: "job",
          SK: "related#CRM#Contact#7",
          target: { app: "CRM", type: "Contact", id: "7" },
          source: { app: "Jobs", type: "Job", id: "1" },
        },
        // Its SK ends as a copy under the audit's own target would
        {
          id: "own",
          SK: relatedSortKey({ app: "Jobs", type: "Job", id: "7#Jobs.Job#1" }),
          target: { app: "Jobs", type: "Job", id: "7#Jobs.Job#1" },
          source: { app: "Jobs", type: "Job", id: "1" },
        },
        {
          id: "x#CRM.Contact#7",
          SK: "related#CRM#Contact#8",
          target: { app: "CRM", type: "Contact", id: "8" },
          source: { app: "Jobs", type: "Job", id: "1" },
        },
      ]);
      // In each audit's partition
      const audits = table.filter(({ SK }) => SK === "audit");
      for (const copy of copies) {
        expect(audits.find(({ id }) => id === copy.id)?.PK).toBe(copy.PK);
      }
    });

    it("gives back the empty strings SDK 1.4.1 stored as NULL", async () => {
      const { client, send } = stubClient([released["1.4.1"]]);

      const report = await migrate({ client, from: FROM, to: TO });

      expect(report.invalid.map(({ SK }) => SK)).not.toContain("empty");
      const audit = putItems(send).find(({ id }) => id === "empty");
      expect(audit).toMatchObject({
        operation: "",
        context: { note: "", nested: { value: "" } },
        event: { source: "jobs", "detail-type": "Sync", detail: "" },
      });
      // A null message is none
      expect(audit).not.toHaveProperty("message");
    });

    it("writes SDK 1.8.0's copies under their targets", async () => {
      const { client, send } = stubClient([released["1.8.0"]]);

      const report = await migrate({ client, from: FROM, to: TO });

      expect(report).toMatchObject({ audits: { written: 3 }, copies: { written: 2 }, invalid: [] });
      const copy = putItems(send).find(({ related, id }) => related && id === "job");
      expect(copy).toMatchObject({
        PK: "-#Jobs#Job#job",
        SK: "related#CRM#Contact#7",
        id: "job",
        target: { app: "CRM", type: "Contact", id: "7" },
        source: { app: "Jobs", type: "Job", id: "1" },
      });
    });
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

  it("gives back the empty strings the earlier SDK stored as NULL, where a null isn't valid", async () => {
    const { client, send } = stubClient([
      [
        v1Audit({
          operation: null,
          trace: null,
          context: { note: null, nested: { label: null } },
          event: { source: "orders", "detail-type": null, detail: null },
          source: { app: "TestApp", type: "User", id: null },
          error: { code: null },
          attempts: [{ number: 1, status: "fail", error: null, at: NOW }],
        }),
      ],
    ]);

    const report = await migrate({ client, from: FROM, to: TO });

    expect(report.invalid).toEqual([]);
    expect(putItems(send)[0]).toMatchObject({
      operation: "",
      trace: "",
      context: { note: "", nested: { label: "" } },
      event: { source: "orders", "detail-type": "", detail: "" },
      source: { app: "TestApp", type: "User", id: "" },
      // A null is valid in an error object, so it may have been one
      error: { code: null },
      attempts: [{ number: 1, status: "fail", error: "", at: NOW }],
    });
  });

  describe("an audit retried since the deploy", () => {
    const EARLIER = "2026-01-01T00:00:00.000Z";
    /** The audit as a retry since the deploy upserted it, without the earlier fields it left out */
    const v2Audit = (overrides: Record<string, unknown> = {}) => ({
      PK: "-#App1#Order#audit-1",
      SK: "audit",
      id: "audit-1",
      operation: "createOrder",
      status: "success",
      tier: 2,
      target: { app: "App1", type: "Order", id: "order-1" },
      attempts: [{ number: 1, status: "success", at: NOW }],
      createdAt: NOW,
      updatedAt: NOW,
      tenantKey: "-",
      app: "App1",
      resourceType: "Order",
      resourceId: "order-1",
      kind: "audit",
      scopes: new Set(["App1", "App1#Order", "*#Order", "App1#Order#order-1"]),
      ttl: 1775999999,
      ...overrides,
    });
    /** The earlier audit's fields, which the retry gave too */
    const given = {
      context: { attempt: 3 },
      event: { source: "orders", "detail-type": "OrderCreated", detail: "{}" },
      error: "Boom",
      trace: "trace-1:2",
      traceId: "trace-1",
      traceStage: 2,
    };
    const v2Copy = {
      PK: "-#App1#Order#audit-1",
      SK: "related#TestApp#User#user-1",
      target: { app: "TestApp", type: "User", id: "user-1" },
    };
    const isAuditPut = (command: PutItemCommand | UpdateItemCommand) =>
      command instanceof PutItemCommand && unmarshall(command.input.Item!).SK === "audit";

    it("gets the earlier attempts first and the earlier createdAt, as do its copies", async () => {
      const { client, send } = stubClient([[v1Audit({ createdAt: EARLIER })]], isAuditPut, [
        v2Audit(given),
        v2Copy,
      ]);

      const report = await migrate({ client, from: FROM, to: TO });

      const updates = commands(send, UpdateItemCommand).map(({ input }) => ({
        key: unmarshall(input.Key!),
        expression: input.UpdateExpression,
        condition: input.ConditionExpression,
        values: unmarshall(input.ExpressionAttributeValues!),
      }));
      expect(updates).toEqual([
        {
          key: { PK: "-#App1#Order#audit-1", SK: "audit" },
          // The retry succeeded, so the earlier failure's event isn't rerunable
          expression:
            "SET #attempts = :attempts, #createdAt = :createdAt, #migrated = :migrated, #f0 = :f0",
          condition:
            "attribute_not_exists(#migrated) AND #createdAt = :current AND size(#attempts) = :count",
          values: {
            ":attempts": [
              { number: 1, status: "fail", error: "Boom", at: NOW },
              { number: 2, status: "success", at: NOW },
            ],
            ":createdAt": EARLIER,
            ":migrated": true,
            ":current": NOW,
            ":count": 1,
            ":f0": false,
          },
        },
      ]);
      expect(report.audits).toEqual({ written: 0, existing: 0, merged: 1 });

      // Before the merge, as the audit's revision, and after it, as the merged one
      const copies = commands(send, PutItemCommand).filter(
        ({ input }) => unmarshall(input.Item!).related,
      );
      expect(send.mock.calls.map(([command]) => command).indexOf(copies[1])).toBeGreaterThan(
        send.mock.calls.findIndex(([command]) => command instanceof UpdateItemCommand),
      );
      expect(
        copies.map(({ input }) => ({
          condition: input.ConditionExpression,
          values: unmarshall(input.ExpressionAttributeValues!),
        })),
      ).toEqual(
        [1, 2].map((revision) => ({
          condition:
            "attribute_exists(#pk) AND (attribute_not_exists(#revision) OR #revision <= :revision)",
          values: { ":revision": revision },
        })),
      );
      expect(unmarshall(copies[1].input.Item!)).toEqual({
        PK: "-#App1#Order#audit-1",
        SK: "related#TestApp#User#user-1",
        id: "audit-1",
        operation: "createOrder",
        status: "success",
        tier: 2,
        trace: "trace-1:2",
        target: { app: "TestApp", type: "User", id: "user-1" },
        source: { app: "App1", type: "Order", id: "order-1" },
        // It succeeded: the event is the earlier failure's
        rerunable: false,
        related: true,
        createdAt: EARLIER,
        updatedAt: NOW,
        tenantKey: "-",
        app: "TestApp",
        resourceType: "User",
        resourceId: "user-1",
        ttl: 1775999999,
        revision: 2,
      });
    });

    it("gives its copies the audit as merged, whichever page its copy is on", async () => {
      const failed = v1Audit({ createdAt: EARLIER, status: "fail" });
      const copy = v1Copy({ status: "fail" });
      const run = async (pages: Record<string, unknown>[][]) => {
        const { client, send, table } = stubClient(pages, () => false, [v2Audit()]);
        await migrate({ client, from: FROM, to: TO });
        // Read consistently, so a copy put just before is found
        for (const query of commands(send, QueryCommand)) {
          expect(query.input.ConsistentRead).toBe(true);
        }
        return table.find(({ related }) => related);
      };

      const copyFirst = await run([[copy], [failed]]);
      const auditFirst = await run([[failed], [copy]]);

      expect(copyFirst).toEqual(auditFirst);
      expect(auditFirst).toMatchObject({ status: "success", createdAt: EARLIER, revision: 2 });
    });

    it("deletes a copy under its target, from before a retry made that resource its target", async () => {
      const { client, table } = stubClient([[v1Audit()]], () => false, [
        v2Audit(given),
        {
          PK: "-#App1#Order#audit-1",
          SK: "related#App1#Order#order-1",
          target: { app: "App1", type: "Order", id: "order-1" },
          revision: 1,
        },
      ]);

      await migrate({ client, from: FROM, to: TO });

      expect(table.filter(({ related, SK }) => related || SK !== "audit")).toEqual([]);
    });

    it("gives its copies the earlier fields the retries left out", async () => {
      const { client, send } = stubClient(
        [[v1Audit({ createdAt: EARLIER, message: "Order failed" })]],
        isAuditPut,
        [v2Audit(), v2Copy],
      );

      await migrate({ client, from: FROM, to: TO });

      const copies = putItems(send).filter(({ related }) => related);
      expect(
        copies.map(({ message, trace, createdAt }) => ({ message, trace, createdAt })),
      ).toEqual(
        [1, 2].map(() => ({ message: "Order failed", trace: "trace-1:2", createdAt: EARLIER })),
      );
    });

    it("gets the earlier fields the retries left out, with the index attributes they add", async () => {
      const { client, send } = stubClient([[v1Audit({ message: "Order failed" })]], isAuditPut, [
        v2Audit({ context: { attempt: 3 }, error: "Still failing" }),
      ]);

      await migrate({ client, from: FROM, to: TO });

      const [merge] = commands(send, UpdateItemCommand);
      const names = merge.input.ExpressionAttributeNames!;
      const values = unmarshall(merge.input.ExpressionAttributeValues!);
      const set = Object.fromEntries(
        Object.entries(names)
          .filter(([token]) => token.startsWith("#f"))
          .map(([token, name]) => [name, values[`:${token.slice(1)}`]]),
      );
      // Not the context or error the retry gave, nor the keys and attributes it set
      expect(set).toEqual({
        event: { source: "orders", "detail-type": "OrderCreated", detail: "{}" },
        message: "Order failed",
        trace: "trace-1:2",
        traceId: "trace-1",
        traceStage: 2,
        // From the merged audit, whose retry succeeded
        rerunable: false,
      });
      expect(merge.input.UpdateExpression).toBe(
        "SET #attempts = :attempts, #createdAt = :createdAt, #migrated = :migrated, " +
          "#f0 = :f0, #f1 = :f1, #f2 = :f2, #f3 = :f3, #f4 = :f4, #f5 = :f5",
      );
    });

    it("says the merged audit is rerunable when its retry failed too, by the earlier event", async () => {
      const { client, send } = stubClient([[v1Audit()]], isAuditPut, [
        v2Audit({ status: "fail", attempts: [{ number: 1, status: "fail", at: NOW }] }),
      ]);

      await migrate({ client, from: FROM, to: TO });

      const [merge] = commands(send, UpdateItemCommand);
      const names = merge.input.ExpressionAttributeNames!;
      const values = unmarshall(merge.input.ExpressionAttributeValues!);
      const token = Object.keys(names).find((name) => names[name] === "rerunable")!;
      expect(values[`:${token.slice(1)}`]).toBe(true);
    });

    it("keeps a retry's target, without the earlier target's resourceId", async () => {
      const { client, send } = stubClient([[v1Audit()]], isAuditPut, [
        v2Audit({
          ...given,
          target: { app: "App1", type: "Order" },
          resourceId: undefined,
          scopes: new Set(["App1", "App1#Order", "*#Order"]),
        }),
      ]);

      await migrate({ client, from: FROM, to: TO });

      const [merge] = commands(send, UpdateItemCommand);
      expect(Object.values(merge.input.ExpressionAttributeNames!)).not.toContain("resourceId");
      expect(Object.values(merge.input.ExpressionAttributeNames!)).not.toContain("target");
    });

    it("merges again when an upsert changed it meanwhile", async () => {
      let refused = 0;
      const { client, send } = stubClient(
        [[v1Audit({ createdAt: EARLIER })]],
        (command) =>
          isAuditPut(command) ||
          (command instanceof UpdateItemCommand &&
            command.input.ConditionExpression?.startsWith("attribute_not_exists(#migrated)") ===
              true &&
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

    it("merges a retry that kept the earlier createdAt", async () => {
      const { client, send } = stubClient([[v1Audit({ createdAt: EARLIER })]], isAuditPut, [
        v2Audit({ createdAt: EARLIER }),
        v2Copy,
      ]);

      const report = await migrate({ client, from: FROM, to: TO });

      const [merge] = commands(send, UpdateItemCommand).filter(({ input }) =>
        input.UpdateExpression?.startsWith("SET #attempts"),
      );
      expect(unmarshall(merge.input.ExpressionAttributeValues!)).toMatchObject({
        ":attempts": [
          { number: 1, status: "fail" },
          { number: 2, status: "success" },
        ],
        ":createdAt": EARLIER,
      });
      expect(report.audits).toEqual({ written: 0, existing: 0, merged: 1 });
    });

    it("keeps the v2 createdAt when it's the earlier", async () => {
      const { client, send } = stubClient([[v1Audit({ createdAt: NOW })]], isAuditPut, [
        v2Audit({ createdAt: EARLIER }),
      ]);

      await migrate({ client, from: FROM, to: TO });

      const [merge] = commands(send, UpdateItemCommand);
      expect(unmarshall(merge.input.ExpressionAttributeValues!)).toMatchObject({
        ":createdAt": EARLIER,
      });
    });

    it("is left alone once merged", async () => {
      const { client, send } = stubClient([[v1Audit({ createdAt: EARLIER })]], isAuditPut, [
        v2Audit({ createdAt: EARLIER, migrated: true }),
        v2Copy,
      ]);

      const report = await migrate({ client, from: FROM, to: TO });

      expect(commands(send, UpdateItemCommand)).toEqual([]);
      expect(putItems(send).filter(({ related }) => related)).toEqual([]);
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
        // Ends as a copy under its own target would: its attempts say it's an audit
        v1Audit({ SK: "job#App1.Order#order-1", id: "job#App1.Order#order-1" }),
      ],
    ]);

    const report = await migrate({ client, from: FROM, to: TO });

    expect(report).toMatchObject({
      audits: { written: 3 },
      copies: { written: 0, ownTarget: 0 },
      invalid: [],
    });
    expect(putItems(send).map(({ PK, SK }) => [PK, SK])).toEqual([
      ["-#App1#Order#batch%237", "audit"],
      ["-#App1#Order#a%23App1.Order%23order-1%23x", "audit"],
      ["-#App1#Order#job%23App1.Order%23order-1", "audit"],
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a concurrency of %s", async (concurrency) => {
    const { client, send } = stubClient([[v1Audit()]]);

    await expect(migrate({ client, from: FROM, to: TO, concurrency })).rejects.toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
  });

  const ARN = `arn:aws:dynamodb:us-east-1:123456789012:table/${FROM}`;
  it.each([
    // Merging a table into itself would add each audit's attempts to it again
    { from: FROM, to: FROM, error: "from and to must name two different tables" },
    // As would naming it by its name and its ARN
    { from: FROM, to: ARN, error: "from and to must be table names, not ARNs" },
    { from: ARN, to: TO, error: "from and to must be table names, not ARNs" },
    { from: "", to: TO, error: "from and to must be table names, not ARNs" },
    { from: FROM, to: "", error: "from and to must be table names, not ARNs" },
  ])(
    "refuses to migrate from $from to $to, before it reads either",
    async ({ from, to, error }) => {
      const { client, send } = stubClient([[v1Audit()]]);

      await expect(migrate({ client, from, to })).rejects.toThrow(new RangeError(error));
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("keeps every write, copies' included, within the concurrency", async () => {
    const resources = Array.from({ length: 12 }, (_, n) => `user-${n}`);
    const { client, send } = stubClient([
      [
        v1Audit(),
        ...resources.map((id) =>
          v1Copy({
            SK: `audit-1#TestApp.User#${id}`,
            target: { app: "TestApp", type: "User", id },
          }),
        ),
      ],
    ]);
    // Each write takes a moment, so overlapping writes are seen
    const writes = { active: 0, most: 0, count: 0 };
    const stub = send.getMockImplementation()!;
    send.mockImplementation(async (command) => {
      if (!(command instanceof PutItemCommand || command instanceof UpdateItemCommand)) {
        return stub(command);
      }
      writes.most = Math.max(writes.most, ++writes.active);
      writes.count++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      writes.active--;
      return stub(command);
    });

    for (const concurrency of [1, 4]) {
      Object.assign(writes, { most: 0, count: 0 });
      await migrate({ client, from: FROM, to: TO, concurrency });

      // The audit and its copies, then the scopes and the copies again
      expect(writes.count).toBeGreaterThan(25);
      expect(writes.most).toBe(concurrency);
    }
  });

  describe("a write that fails", () => {
    /** An audit and its 12 copies, which are put again from it once it's written */
    const pages = () => [
      [
        v1Audit(),
        ...Array.from({ length: 12 }, (_, n) =>
          v1Copy({
            SK: `audit-1#TestApp.User#user-${n}`,
            target: { app: "TestApp", type: "User", id: `user-${n}` },
          }),
        ),
      ],
    ];
    /** Its writes take a moment; the first copy put again from the audit fails */
    const failing = (send: ReturnType<typeof stubClient>["send"]) => {
      const writes = { active: 0, started: 0, afterFailure: 0, failed: false };
      const stub = send.getMockImplementation()!;
      send.mockImplementation(async (command) => {
        const write = command instanceof PutItemCommand || command instanceof UpdateItemCommand;
        if (!write) return stub(command);

        writes.started++;
        if (writes.failed) writes.afterFailure++;
        writes.active++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        writes.active--;
        const reconciling = String(command.input.ConditionExpression).includes("#revision");
        if (reconciling && !writes.failed) {
          writes.failed = true;
          throw new Error("ProvisionedThroughputExceededException");
        }
        return stub(command);
      });
      return writes;
    };

    it.each([1, 4])(
      "stops the writes queued behind it, at a concurrency of %s",
      async (concurrency) => {
        const { client, send } = stubClient(pages());
        const writes = failing(send);

        await expect(migrate({ client, from: FROM, to: TO, concurrency })).rejects.toThrow(
          "ProvisionedThroughputExceededException",
        );

        // Only those in flight with it, and none once it has rejected
        expect(writes.afterFailure).toBeLessThan(concurrency);
        expect(writes.active).toBe(0);
        const started = writes.started;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(writes.started).toBe(started);
      },
    );
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

  it("reports an item whose v2 keys are longer than DynamoDB allows, on a dry run too, and copies the rest", async () => {
    // Each within the earlier table's limits, but not escaped and joined
    const tenantId = "t".repeat(1500);
    const id = "%".repeat(200);
    const long = v1Audit({ PK: `${tenantId}#App1.Order`, SK: id, id, tenantId });
    const longCopy = v1Copy({
      SK: `audit-1#TestApp.User#${"%".repeat(400)}`,
      target: { app: "TestApp", type: "User", id: "%".repeat(400) },
    });

    for (const dryRun of [true, false]) {
      const { client } = stubClient([[long, longCopy, v1Audit()]]);

      const report = await migrate({ client, from: FROM, to: TO, dryRun });

      expect(report.audits.written).toBe(1);
      expect(report.invalid).toEqual([
        {
          PK: long.PK,
          SK: id,
          reason: "Its v2 PK would be 2112 bytes, over DynamoDB's 2048-byte limit for a key",
        },
        {
          PK: "TestApp.User",
          SK: longCopy.SK,
          reason: "Its v2 SK would be 1221 bytes, over DynamoDB's 1024-byte limit for a key",
        },
      ]);
    }
  });

  it("reports an item with an empty v2 key, on a dry run too", async () => {
    const empty = v1Audit({ SK: "audit-2", id: "audit-2", target: { app: "App1", type: "" } });

    for (const dryRun of [true, false]) {
      const { client } = stubClient([[empty, v1Audit()]]);

      const report = await migrate({ client, from: FROM, to: TO, dryRun });

      expect(report.audits.written).toBe(1);
      expect(report.invalid).toEqual([
        {
          PK: "App1.Order",
          SK: "audit-2",
          reason: "Its v2 resourceType would be empty, which DynamoDB doesn't allow for a key",
        },
      ]);
    }
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
