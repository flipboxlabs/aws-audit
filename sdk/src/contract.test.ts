/**
 * Records the AWS requests the SDK sends, and what it returns, as JSON fixtures
 * under `contract/fixtures/sdk` for the Rust port (#93) to replay.
 *
 * Each fixture lists the service calls in order: the command input the SDK
 * built and the response fed back to it. A port passes when it sends the same
 * inputs given the same responses, and returns the same result or error.
 *
 * The committed files are file snapshots: this test fails when the SDK's
 * behavior drifts from them. Regenerate with `pnpm contract:update`.
 */
import type { Logger } from "@aws-lambda-powertools/logger";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { Audits } from "./audits.js";
import { DynamoDB, type IndexDefinition } from "./constants.js";
import { BatchHandler } from "./events/batch-handler.js";
import { AuditEventBus } from "./events/bus.js";
import { AuditRepository, resourceScopes } from "./repository.js";
import { decodeNextPageToken, encodeNextPageToken, type PageKey } from "./repository.utils.js";
import { DateTimeStringSchema } from "./schema/common.js";
import type { LogAuditInput } from "./schema/log.js";
import { AuditService } from "./service.js";
import { testConfig } from "./test-config.js";

const FIXTURES = "../../contract/fixtures/sdk";

/** Fixed clock for createdAt, updatedAt, attempt times and ttl */
const NOW = "2026-01-02T03:04:05.678Z";

const ENV = { ENVIRONMENT: "test", SERVICE: "Contract" } as const;

type Call = {
  service: "DynamoDB" | "EventBridge";
  command: string;
  input: unknown;
  output?: unknown;
  error?: { name: string; message: string };
};

type Reply = { output: unknown } | { error: { name: string; message: string } };

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  critical: vi.fn(),
} as unknown as Logger;

/**
 * Builds a service on recording clients that answer each call, across both
 * services, with the next reply in order (an empty response once they run out).
 */
const recordingService = (replies: Reply[]) => {
  const calls: Call[] = [];
  const queue = [...replies];

  const client = (service: Call["service"]) => ({
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      const call: Call = {
        service,
        command: command.constructor.name.replace(/Command$/, ""),
        input: structuredClone(command.input),
      };
      calls.push(call);

      const reply = queue.shift() ?? { output: {} };
      if ("error" in reply) {
        call.error = reply.error;
        throw Object.assign(new Error(reply.error.message), { name: reply.error.name });
      }

      call.output = reply.output;
      return structuredClone(reply.output);
    },
  });

  const repository = new AuditRepository(
    logger,
    testConfig,
    client("DynamoDB") as unknown as DynamoDBClient,
  );
  const events = new AuditEventBus(
    logger,
    new BatchHandler(logger, client("EventBridge") as unknown as EventBridgeClient),
  );

  return { calls, service: new AuditService(logger, testConfig, repository, events) };
};

type Operation =
  | "getItem"
  | "upsertItem"
  | "listObjects"
  | "listItems"
  | "listTraceItems"
  | "listByStatus";

/** The UpdateItem reply of an upsert: the audit as stored, from the case's input */
type StoredReply = {
  stored: { count: number; createdAt?: string; kept?: Record<string, unknown> };
};

/**
 * The GetItem reply that reads an upsert's audit back once its copies are put: the
 * audit as stored, `migrated` when a migration merged a 1.x audit into it meanwhile
 */
type ReadBackReply = {
  readBack: StoredReply["stored"] & {
    migrated?: true;
    /** Fields an overlapping upsert changed since */
    since?: Record<string, unknown>;
  };
};

type Case = {
  name: string;
  description: string;
  operation: Operation;
  args: unknown[];
  replies?: (Reply | StoredReply | ReadBackReply)[];
};

/**
 * What UpdateItem's `ALL_NEW` returns for an upsert of `input`: its fields and its
 * resources' `scopes`, over those an earlier attempt `kept`, with `count` attempts.
 */
const storedReply = (
  input: Record<string, unknown>,
  { count, createdAt, kept = {} }: StoredReply["stored"],
): Reply => {
  const { resources, attempts: _, ...fields } = input;
  const listed = [fields.target, ...((resources as unknown[] | undefined) ?? [])];
  return {
    output: {
      Attributes: marshall(
        {
          status: "success",
          tier: 2,
          scopes: new Set(
            (listed as Parameters<typeof resourceScopes>[0][]).flatMap(resourceScopes),
          ),
          ...kept,
          ...fields,
          createdAt: createdAt ?? DateTimeStringSchema.parse(fields.createdAt ?? NOW),
          updatedAt: NOW,
          attempts: Array.from({ length: count }, (_, i) => ({
            number: i + 1,
            status: "success",
            at: NOW,
          })),
        },
        { removeUndefinedValues: true },
      ),
    },
  };
};

/** What GetItem returns for the audit of an upsert of `input` (see {@link ReadBackReply}) */
const readBackReply = (
  input: Record<string, unknown>,
  { migrated, since = {}, ...stored }: ReadBackReply["readBack"],
): Reply => {
  const { output } = storedReply(input, stored) as { output: { Attributes: object } };
  return {
    output: {
      Item: { ...output.Attributes, ...marshall({ ...since, ...(migrated ? { migrated } : {}) }) },
    },
  };
};

const record = async ({ name, description, operation, args, replies = [] }: Case) => {
  const input = args[0] as Record<string, unknown>;
  const { calls, service } = recordingService(
    replies.map((reply) =>
      "stored" in reply
        ? storedReply(input, reply.stored)
        : "readBack" in reply
          ? readBackReply(input, reply.readBack)
          : reply,
    ),
  );

  let result: unknown;
  let error: { name: string; message: string } | undefined;

  try {
    // oxlint-disable-next-line typescript/no-explicit-any -- args are fixture data
    result = await (service[operation] as (...a: any[]) => Promise<unknown>)(
      ...structuredClone(args),
    );
  } catch (e) {
    error = { name: (e as Error).name, message: (e as Error).message };
  }

  const fixture = {
    description,
    operation,
    args,
    calls,
    ...(error ? { error } : { result: result ?? null }),
  };

  await expect(`${JSON.stringify(fixture, null, 2)}\n`).toMatchFileSnapshot(
    `${FIXTURES}/${name}.json`,
  );
};

/** An audit's stored item, unmarshalled */
const auditRow = (overrides: Record<string, unknown> = {}) => ({
  PK: "-#App1#Order#audit-1",
  SK: "audit",
  id: "audit-1",
  operation: "createOrder",
  status: "success",
  tier: 2,
  target: { app: "App1", type: "Order", id: "order-1" },
  createdAt: NOW,
  updatedAt: NOW,
  tenantKey: "-",
  app: "App1",
  resourceType: "Order",
  resourceId: "order-1",
  kind: "audit",
  scopes: new Set(["App1", "App1#Order", "*#Order", "App1#Order#order-1"]),
  ttl: 1775099045,
  ...overrides,
});

/** An audit's stored item, as GetItem returns it */
const storedAudit = (overrides: Record<string, unknown> = {}) =>
  marshall(auditRow(overrides), { removeUndefinedValues: true });

/** A related-resource copy of `audit-1` under `TestApp.User` `user-1` */
const copyOverrides = {
  SK: "related#TestApp#User#user-1",
  target: { app: "TestApp", type: "User", id: "user-1" },
  source: { app: "App1", type: "Order", id: "order-1" },
  app: "TestApp",
  resourceType: "User",
  resourceId: "user-1",
  kind: undefined,
  scopes: undefined,
};

/**
 * A row as an index returns it: the table keys, the index's keys and the summary
 * attributes the CDK table projects.
 */
const indexRow = (index: IndexDefinition, overrides: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = auditRow(overrides);
  const projected = [
    DynamoDB.Keys.PARTITION_KEY,
    DynamoDB.Keys.SORT_KEY,
    ...[...index.partitionKeys, ...index.sortKeys].map((key) => key.name),
    ...DynamoDB.Projections.SUMMARY,
  ];

  return marshall(
    Object.fromEntries(
      projected.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
    ),
  );
};

/** An index row's LastEvaluatedKey: the table keys and the index's keys */
const lastKey = (index: IndexDefinition, overrides: Record<string, unknown> = {}): PageKey => {
  const row: Record<string, unknown> = auditRow(overrides);
  return Object.fromEntries(
    [
      DynamoDB.Keys.PARTITION_KEY,
      DynamoDB.Keys.SORT_KEY,
      ...[...index.partitionKeys, ...index.sortKeys].map((key) => key.name),
    ].map((key) => [key, row[key] as string | number]),
  );
};

const { BY_TYPE, BY_RESOURCE, BY_STATUS, BY_TRACE } = DynamoDB.Indexes;

const traced = { trace: "trace-1:2", traceId: "trace-1", traceStage: 2 };

const accepted = (count = 1) => ({
  output: {
    FailedEntryCount: 0,
    Entries: Array.from({ length: count }, (_, i) => ({ EventId: `event-${i + 1}` })),
  },
});

/** UpdateItem's ALL_NEW reply after this many attempts, with the stored createdAt */
/** An upsert's UpdateItem reply: the audit as stored, with `count` attempts */
const attempts = (
  count: number,
  createdAt?: string,
  kept?: Record<string, unknown>,
): StoredReply => ({ stored: { count, createdAt, kept } });

const upsertInput = (overrides: Record<string, unknown> = {}) => ({
  id: "audit-1",
  operation: "createOrder",
  status: "success",
  tier: 2,
  target: { app: "App1", type: "Order", id: "order-1" },
  ...overrides,
});

const CASES: Case[] = [
  // getItem
  {
    name: "get-item/found",
    description: "GetItem by app, type and id returns the whole audit without storage attributes",
    operation: "getItem",
    args: [{ app: "App1", resourceType: "Order", id: "audit-1" }],
    replies: [
      {
        output: {
          Item: storedAudit({
            ...traced,
            status: "fail",
            error: "Boom",
            attempts: [{ number: 1, status: "fail", error: "Boom", at: NOW }],
            context: { region: "us-east-1" },
            event: { source: "orders", "detail-type": "OrderCreated", detail: "{}" },
          }),
        },
      },
    ],
  },
  {
    name: "get-item/null-trace",
    description: "A trace stored as NULL (an empty trace) is left out",
    operation: "getItem",
    args: [{ app: "App1", resourceType: "Order", id: "audit-1" }],
    replies: [{ output: { Item: storedAudit({ trace: null }) } }],
  },
  {
    name: "get-item/tenant",
    description: "A tenant is the first part of the partition key",
    operation: "getItem",
    args: [{ tenantId: "tenant-1", app: "App1", resourceType: "Order", id: "audit-1" }],
    replies: [
      {
        output: {
          Item: storedAudit({
            PK: "tenant-1#App1#Order#audit-1",
            tenantId: "tenant-1",
            tenantKey: "tenant-1",
          }),
        },
      },
    ],
  },
  {
    name: "get-item/not-found",
    description: "GetItem without an Item fails with AuditNotFoundError",
    operation: "getItem",
    args: [{ app: "App1", resourceType: "Order", id: "missing" }],
    replies: [{ output: {} }],
  },

  // upsertItem
  {
    name: "upsert/minimal",
    description: "First write of an audit with only the required fields",
    operation: "upsertItem",
    args: [{ id: "audit-1", operation: "createOrder", target: { app: "App1", type: "Order" } }],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/full",
    description: "First write with trace, source, context, message, error and event",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        tier: 1,
        trace: "trace-1:2",
        source: { app: "TestApp", type: "User", id: 42 },
        context: { attempt: 1, label: "retry", nested: { ok: false } },
        message: "Order failed",
        error: "Boom",
        event: {
          source: "orders",
          "detail-type": "OrderCreated",
          detail: '{"orderId":"order-1"}',
        },
      }),
    ],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/retry",
    description:
      "A second write of the same audit numbers its attempt with a follow-up UpdateItem, and deletes any copy under its target, which an earlier attempt may have listed",
    operation: "upsertItem",
    args: [upsertInput({ status: "fail", error: "Still failing" })],
    replies: [attempts(2, "2026-01-01T00:00:00.000Z"), { output: {} }, { output: {} }, accepted()],
  },
  {
    name: "upsert/retarget",
    description:
      "A retry that changes the target's id removes from scopes each resource of the target's app and type there but its target, as the targets it replaces, unless a related resource's copy (read consistently) lists the audit under it, and only if no upsert appended an attempt since; a copy put since the check (read again) puts its resource back",
    operation: "upsertItem",
    args: [upsertInput({ status: "fail", target: { app: "App1", type: "Order", id: "order-2" } })],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z", {
        scopes: new Set([
          "App1",
          "App1#Order",
          "*#Order",
          "App1#Order#order-1",
          "App1#Order#order-2",
          "App1#Order#order-3",
          "App1#Order#order-4",
          "TestApp#User#user-1",
        ]),
      }),
      { output: {} },
      // The copies under order-1, order-3 and order-4: order-3's lists the audit there
      { output: {} },
      { output: { Item: marshall({ PK: "-#App1#Order#audit-1" }) } },
      { output: {} },
      { output: {} },
      // Again, once removed: an overlapping upsert put order-4's since
      { output: {} },
      { output: { Item: marshall({ PK: "-#App1#Order#audit-1" }) } },
      { output: {} },
      { output: {} },
      accepted(),
    ],
  },
  {
    name: "upsert/retarget-since",
    description:
      "A retry that changes the target's id leaves the scopes to a later upsert, which appended an attempt since and removes them from the audit as it stored it",
    operation: "upsertItem",
    args: [upsertInput({ status: "fail", target: { app: "App1", type: "Order", id: "order-2" } })],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z", {
        scopes: new Set([
          "App1",
          "App1#Order",
          "*#Order",
          "App1#Order#order-1",
          "App1#Order#order-2",
        ]),
      }),
      { output: {} },
      { output: {} },
      {
        error: {
          name: "ConditionalCheckFailedException",
          message: "The conditional request failed",
        },
      },
      { output: {} },
      accepted(),
    ],
  },
  {
    name: "upsert/retry-long-keys",
    description:
      "A retry deletes no copy under a target, and puts none under a related resource, whose copy's SK would be longer than DynamoDB allows: none could be stored",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        target: { app: "App1", type: "Order", id: "o".repeat(1100) },
        resources: [{ app: "TestApp", type: "User", id: "u".repeat(1100) }],
      }),
    ],
    replies: [attempts(2, "2026-01-01T00:00:00.000Z"), { output: {} }, accepted()],
  },
  {
    name: "upsert/tenant",
    description:
      "A tenant is the first part of the partition key and the index attributes' tenantKey",
    operation: "upsertItem",
    args: [upsertInput({ tenantId: "tenant-1", trace: "trace-1" })],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/empty-tenant",
    description: "An empty tenant id is none: it isn't stored, and the keys have the tenant key -",
    operation: "upsertItem",
    args: [upsertInput({ tenantId: "" })],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/empty-strings",
    description:
      "Empty strings are stored as such, not as NULL, so the audit as stored is valid: in context, as the message and as the target's id",
    operation: "upsertItem",
    args: [
      upsertInput({
        target: { app: "App1", type: "Order", id: "" },
        context: { note: "", nested: { label: "" } },
        message: "",
      }),
    ],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/escaped-keys",
    description:
      "%, # and * in each part of a key or scope are escaped as %25, %23 and %2A, so distinct audits never share a key",
    operation: "upsertItem",
    args: [
      upsertInput({
        tenantId: "tenant#1",
        id: "audit#1%*",
        target: { app: "App1", type: "Order", id: "order#1" },
        resources: [{ app: "TestApp", type: "User", id: "user#1" }],
      }),
    ],
    replies: [attempts(1), { output: {} }, { readBack: { count: 1 } }, accepted()],
  },
  {
    name: "upsert/related-resources",
    description:
      "Each related resource with an id gets a summary copy in the audit's partition, put as the audit's attempt count (revision) over none of a later one",
    operation: "upsertItem",
    args: [
      upsertInput({
        trace: "trace-1",
        message: "Order created",
        resources: [
          { app: "TestApp", type: "User", id: "user-1" },
          { app: "App1", type: "Unknown", id: 7 },
          { app: "App1", type: "User" },
        ],
        event: { source: "orders", "detail-type": "OrderCreated", detail: "{}" },
      }),
    ],
    replies: [attempts(1), { output: {} }, { output: {} }, { readBack: { count: 1 } }, accepted()],
  },
  {
    name: "upsert/repeated-related",
    description: 'A resource listed twice (7 and "7" alike) gets one copy, from its last listing',
    operation: "upsertItem",
    args: [
      upsertInput({
        resources: [
          { app: "TestApp", type: "User", id: 7 },
          { app: "App1", type: "Order", id: "order-2" },
          { app: "TestApp", type: "User", id: "7" },
        ],
      }),
    ],
    replies: [attempts(1), { output: {} }, { output: {} }, { readBack: { count: 1 } }, accepted()],
  },
  {
    name: "upsert/own-target-related",
    description:
      "No copy under the audit's own target, which it lists under already; with no other resource, no PutItem",
    operation: "upsertItem",
    args: [
      upsertInput({
        resources: [{ app: "App1", type: "Order", id: "order-1" }],
      }),
    ],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/created-at-precision",
    description:
      "A given createdAt is stored with milliseconds, as every listing sorts on it as text",
    operation: "upsertItem",
    args: [upsertInput({ createdAt: "2026-01-01T00:00:00.5Z" })],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/retry-related",
    description: "On a retry, the copies take the audit's stored createdAt, not this attempt's",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        resources: [{ app: "TestApp", type: "User", id: "user-1" }],
      }),
    ],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z"),
      { output: {} },
      { output: {} },
      { output: {} },
      { readBack: { count: 2, createdAt: "2026-01-01T00:00:00.000Z" } },
      accepted(),
    ],
  },
  {
    name: "upsert/stale-related",
    description:
      "A copy a later upsert of the audit put already (a later revision) is left as it is, and the upsert carries on",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        resources: [
          { app: "TestApp", type: "User", id: "user-1" },
          { app: "App1", type: "Unknown", id: 7 },
        ],
      }),
    ],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z"),
      { output: {} },
      { output: {} },
      {
        error: {
          name: "ConditionalCheckFailedException",
          message: "The conditional request failed",
        },
      },
      { output: {} },
      { readBack: { count: 2, createdAt: "2026-01-01T00:00:00.000Z" } },
      accepted(),
    ],
  },
  {
    name: "upsert/retry-rerunable-by-stored-event",
    description:
      "A retry that fails without an event keeps the event an earlier attempt stored, so the follow-up UpdateItem that numbers its attempt also sets the flag that event decides",
    operation: "upsertItem",
    args: [upsertInput({ status: "fail", error: "Still failing" })],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z", {
        event: { source: "orders", "detail-type": "OrderCreated", detail: '{"orderId":"order-1"}' },
        rerunable: false,
      }),
      { output: {} },
      { output: {} },
      accepted(),
    ],
  },
  {
    name: "upsert/retry-kept-fields",
    description:
      "A retry keeps the fields it leaves out, and its copies are the audit as stored, with them",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        resources: [{ app: "TestApp", type: "User", id: "user-1" }],
      }),
    ],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z", {
        message: "Order created",
        trace: "trace-1:2",
        rerunable: true,
      }),
      { output: {} },
      { output: {} },
      { output: {} },
      {
        readBack: {
          count: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          kept: { message: "Order created", trace: "trace-1:2", rerunable: true },
        },
      },
      accepted(),
    ],
  },
  {
    name: "upsert/merged-meanwhile",
    description:
      "When a migration merged a 1.x audit into the audit since its upsert (read back migrated, with more attempts), its copies are put again from the merged audit, at its revision",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        resources: [{ app: "TestApp", type: "User", id: "user-1" }],
      }),
    ],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z"),
      { output: {} },
      { output: {} },
      { output: {} },
      {
        readBack: {
          count: 3,
          createdAt: "2025-10-01T00:00:00.000Z",
          kept: { message: "From 1.x" },
          migrated: true,
        },
      },
      { output: {} },
      accepted(),
    ],
  },
  {
    name: "upsert/target-since",
    description:
      "When an overlapping upsert made one of its resources the audit's target (read back), the copy it put there is deleted, unless a later upsert put it",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        resources: [{ app: "App1", type: "Order", id: "order-2" }],
      }),
    ],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z"),
      { output: {} },
      { output: {} },
      { output: {} },
      {
        readBack: {
          count: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          since: { target: { app: "App1", type: "Order", id: "order-2" } },
        },
      },
      { output: {} },
      accepted(),
    ],
  },
  {
    name: "upsert/scopes-since",
    description:
      "When an overlapping retry removed one of its resources from the audit's scopes (read back), as a target it replaced, before the copy there was put, its scopes go back, unless the audit is gone",
    operation: "upsertItem",
    args: [
      upsertInput({
        status: "fail",
        resources: [{ app: "App1", type: "Order", id: "order-3" }],
      }),
    ],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z"),
      { output: {} },
      { output: {} },
      { output: {} },
      {
        readBack: {
          count: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
          since: {
            target: { app: "App1", type: "Order", id: "order-2" },
            scopes: new Set(["App1", "App1#Order", "*#Order", "App1#Order#order-2"]),
          },
        },
      },
      { output: {} },
      accepted(),
    ],
  },
  {
    name: "upsert/retry-without-target-id",
    description:
      "A retry whose target has no id removes resourceId, so the audit lists under its earlier resource no more",
    operation: "upsertItem",
    args: [upsertInput({ target: { app: "App1", type: "Order" } })],
    replies: [attempts(2, "2026-01-01T00:00:00.000Z"), { output: {} }, accepted()],
  },
  {
    name: "upsert/retry-clearing-trace",
    description:
      "A retry with an empty trace removes traceId and traceStage, so the audit lists under its earlier trace no more",
    operation: "upsertItem",
    args: [upsertInput({ trace: "" })],
    replies: [
      attempts(2, "2026-01-01T00:00:00.000Z", { trace: "" }),
      { output: {} },
      { output: {} },
      accepted(),
    ],
  },
  {
    name: "upsert/trace-without-id",
    description:
      "A trace without an id (`:2`) is stored, but sets no traceId or traceStage, as an index key can't be empty, and removes an earlier trace's",
    operation: "upsertItem",
    args: [upsertInput({ trace: ":2" })],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/edge-ids",
    description:
      'A numeric id of 0 is an id (as resourceId "0" and for a related copy); a trace id may contain colons',
    operation: "upsertItem",
    args: [
      upsertInput({
        target: { app: "App1", type: "Order", id: 0 },
        trace: "batch:2026:3",
        resources: [
          { app: "TestApp", type: "User", id: 0 },
          { app: "TestApp", type: "User", id: "" },
          { app: "TestApp", type: "User" },
        ],
      }),
    ],
    replies: [attempts(1), { output: {} }, { readBack: { count: 1 } }, accepted()],
  },
  {
    name: "upsert/event-throttled",
    description: "A throttled Upserted event is resent, then accepted",
    operation: "upsertItem",
    args: [upsertInput()],
    replies: [
      attempts(1),
      {
        output: {
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }],
        },
      },
      accepted(),
    ],
  },
  {
    name: "upsert/event-rejected",
    description: "A non-retryable rejection is not resent and does not fail the upsert",
    operation: "upsertItem",
    args: [upsertInput()],
    replies: [
      attempts(1),
      {
        output: {
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: "MalformedDetail", ErrorMessage: "Detail is malformed" }],
        },
      },
    ],
  },
  {
    name: "upsert/event-call-failed",
    description: "A PutEvents call that throws is not resent and does not fail the upsert",
    operation: "upsertItem",
    args: [upsertInput()],
    replies: [attempts(1), { error: { name: "AccessDeniedException", message: "Not authorized" } }],
  },

  // listObjects
  {
    name: "list-objects/first-page",
    description:
      "Summaries of a resource type's audits and related copies, newest first; LastEvaluatedKey becomes nextToken",
    operation: "listObjects",
    args: [{ app: "TestApp", resource: { type: "User" } }],
    replies: [
      {
        output: {
          Items: [indexRow(BY_TYPE, { ...copyOverrides, ...traced })],
          LastEvaluatedKey: marshall(lastKey(BY_TYPE, copyOverrides)),
        },
      },
    ],
  },
  {
    name: "list-objects/next-page",
    description: "nextToken and pageSize feed ExclusiveStartKey and Limit",
    operation: "listObjects",
    args: [
      { app: "App1", resource: { type: "Order" } },
      { pageSize: 2, nextToken: encodeNextPageToken(lastKey(BY_TYPE)) },
    ],
    replies: [{ output: { Items: [] } }],
  },
  {
    name: "list-objects/filtered",
    description: "Operation and tier filters become a filter expression",
    operation: "listObjects",
    args: [{ app: "App1", resource: { type: "Order" }, operation: "createOrder", tier: 1 }],
    replies: [{ output: { Items: [indexRow(BY_TYPE, { tier: 1 })] } }],
  },

  // listItems
  {
    name: "list-items/basic",
    description:
      "Summaries of one resource's audits, newest first, with the copies of audits naming it as a related resource",
    operation: "listItems",
    args: [{ app: "App1", resource: { type: "Order", id: "order-1" } }],
    replies: [
      {
        output: {
          Items: [
            indexRow(BY_RESOURCE, traced),
            indexRow(BY_RESOURCE, {
              PK: "-#App1#User#audit-2",
              SK: "related#App1#Order#order-1",
              id: "audit-2",
              source: { app: "App1", type: "User", id: "user-1" },
              rerunable: false,
              related: true,
            }),
          ],
        },
      },
    ],
  },
  {
    name: "list-items/numeric-id",
    description: "A numeric resource id is queried as a string",
    operation: "listItems",
    args: [{ app: "App1", resource: { type: "Order", id: 0 } }],
    replies: [{ output: { Items: [] } }],
  },

  // listTraceItems
  {
    name: "list-trace/basic",
    description: "Summaries of a trace's audits, by stage then oldest first",
    operation: "listTraceItems",
    args: [{ trace: "trace-1" }],
    replies: [{ output: { Items: [indexRow(BY_TRACE, traced)] } }],
  },
  {
    name: "list-trace/filtered",
    description:
      "A resource filter matches the audit's scopes (target or related resource); tier filters too",
    operation: "listTraceItems",
    args: [{ trace: "trace-1", app: "App1", resource: { type: "Order", id: "order-1" }, tier: 2 }],
    replies: [{ output: { Items: [indexRow(BY_TRACE, traced)] } }],
  },

  // listByStatus
  {
    name: "list-status/basic",
    description: "Summaries of a status's audits (not their copies), newest first",
    operation: "listByStatus",
    args: [{ status: "fail" }],
    replies: [{ output: { Items: [indexRow(BY_STATUS, { status: "fail", ...traced })] } }],
  },
  {
    name: "list-status/filtered",
    description: "App and type filters match one scope; an app alone matches its own scope",
    operation: "listByStatus",
    args: [{ status: "fail", app: "TestApp", operation: "createOrder" }],
    replies: [{ output: { Items: [indexRow(BY_STATUS, { status: "fail" })] } }],
  },
  {
    name: "list-status/tenant",
    description: "A tenant is the partition's tenantKey",
    operation: "listByStatus",
    args: [{ tenantId: "tenant-1", status: "fail" }, { pageSize: 10 }],
    replies: [
      {
        output: {
          Items: [
            indexRow(BY_STATUS, {
              PK: "tenant-1#App1#Order#audit-1",
              status: "fail",
              tenantId: "tenant-1",
              tenantKey: "tenant-1",
            }),
          ],
        },
      },
    ],
  },

  {
    name: "get-item/reserved-tenant",
    description: "The tenant id of audits without a tenant is refused before any read",
    operation: "getItem",
    args: [{ tenantId: "-", app: "App1", resourceType: "Order", id: "audit-1" }],
    replies: [],
  },
  {
    name: "list-status/reserved-tenant",
    description: "The tenant id of audits without a tenant is refused before any query",
    operation: "listByStatus",
    args: [{ tenantId: "-", status: "fail" }],
    replies: [],
  },

  // nextToken validation: refused before any query
  {
    name: "list-status/token-garbled",
    description: "A nextToken that doesn't decode to a key object is refused",
    operation: "listByStatus",
    args: [{ status: "fail" }, { nextToken: "not-a-token" }],
    replies: [],
  },
  {
    name: "list-status/token-other-index",
    description: "A nextToken holding another index's keys (here listObjects') is refused",
    operation: "listByStatus",
    args: [{ status: "fail" }, { nextToken: encodeNextPageToken(lastKey(BY_TYPE)) }],
    replies: [],
  },
  {
    name: "list-trace/token-wrong-type",
    description: "A nextToken key with the wrong attribute type is refused",
    operation: "listTraceItems",
    args: [
      { trace: "trace-1" },
      { nextToken: encodeNextPageToken({ ...lastKey(BY_TRACE, traced), traceStage: "2" }) },
    ],
    replies: [],
  },
  {
    name: "list-status/token-other-partition",
    description: "A nextToken issued for another status (or tenant) is refused",
    operation: "listByStatus",
    args: [
      { tenantId: "tenant-1", status: "fail" },
      {
        nextToken: encodeNextPageToken(
          lastKey(BY_STATUS, {
            PK: "tenant-1#App1#Order#audit-1",
            tenantKey: "tenant-1",
            status: "warn",
          }),
        ),
      },
    ],
    replies: [],
  },
];

describe("contract fixtures", () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
    // Midpoint jitter, so retry delays are fixed
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubEnv("ENVIRONMENT", ENV.ENVIRONMENT);
    vi.stubEnv("SERVICE", ENV.SERVICE);
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(CASES)("$name", async (fixture) => {
    await record(fixture);
  });

  it("pagination tokens", async () => {
    // One LastEvaluatedKey per listing index
    const keys: PageKey[] = [
      lastKey(BY_TYPE, { PK: "tenant-1#App1#Order#audit-1", tenantKey: "tenant-1" }),
      lastKey(BY_RESOURCE),
      lastKey(BY_STATUS, { status: "fail" }),
      lastKey(BY_TRACE, traced),
    ];
    const tokens = keys.map((key) => {
      const token = encodeNextPageToken(key);
      return { key, token, decoded: decodeNextPageToken(token) };
    });

    await expect(
      `${JSON.stringify({ description: "nextToken encoding (encodeNextPageToken)", tokens }, null, 2)}\n`,
    ).toMatchFileSnapshot(`${FIXTURES}/pagination-tokens.json`);
  });

  it("audit log lines", async () => {
    // A Lambda's trace header; audits without a trace get its root
    const traceHeader =
      "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=557abcec3ee5a047;Sampled=1";
    vi.stubEnv("_X_AMZN_TRACE_ID", traceHeader);
    vi.stubEnv("POWERTOOLS_AUDITS_DISABLED", "false");

    const inputs: { name: string; input: LogAuditInput }[] = [
      {
        name: "defaults",
        input: { operation: "createOrder", target: { app: "App1", type: "Order", id: "order-1" } },
      },
      {
        name: "every field",
        input: {
          error: "Boom",
          event: {
            source: "orders",
            "detail-type": "OrderCreated",
            detail: { orderId: 7, nested: { ok: true } },
          },
          trace: "batch-1:2",
          message: "Order failed",
          resources: [
            { app: "TestApp", type: "User", id: 7 },
            { app: "TestApp", type: "User", id: 1.5 },
            { app: "App1", type: "Unknown" },
          ],
          context: { attempt: 2, ok: false, nested: { b: "1", a: 2.5 } },
          source: { type: "User", app: "TestApp" },
          target: { type: "Order", id: 42, app: "App1" },
          status: "fail",
          tier: 3,
          tenantId: "tenant-1",
          operation: "createOrder",
          id: "audit-1",
        },
      },
      {
        name: "empty trace",
        input: { operation: "createOrder", target: { app: "App1", type: "Order" }, trace: "" },
      },
      {
        name: "string event detail",
        input: {
          operation: "rerun",
          target: { app: "App1", type: "Order" },
          event: { detail: '{ "kept": "as is" }' },
        },
      },
    ];

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const cases = inputs.map(({ name, input }) => {
      write.mockClear();
      const audits = new Audits({ config: testConfig });
      audits.addAudit(structuredClone(input) as never);
      audits.publishStoredAudits();
      const line = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      return { name, input, line };
    });
    write.mockRestore();
    vi.unstubAllEnvs();
    vi.stubEnv("ENVIRONMENT", ENV.ENVIRONMENT);
    vi.stubEnv("SERVICE", ENV.SERVICE);

    await expect(
      `${JSON.stringify({ description: "What Audits logs for each input (publishStoredAudits)", traceHeader, cases }, null, 2)}\n`,
    ).toMatchFileSnapshot(`${FIXTURES}/log-lines.json`);
  });
});
