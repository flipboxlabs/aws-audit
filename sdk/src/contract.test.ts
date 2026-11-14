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
import { DynamoDB } from "./constants.js";
import { BatchHandler } from "./events/batch-handler.js";
import { AuditEventBus } from "./events/bus.js";
import { AuditRepository } from "./repository.js";
import { decodeNextPageToken, encodeNextPageToken, type PageKey } from "./repository.utils.js";
import { AuditService } from "./service.js";
import { testConfig } from "./test-config.js";

const FIXTURES = "../../contract/fixtures/sdk";

/** Fixed clock for createdAt, updatedAt, attempt times and ttl */
const NOW = "2026-01-02T03:04:05.678Z";

const ENV = { ENVIRONMENT: "test", SERVICE: "Contract" } as const;
/** Table name the SDK derives from ENV, used to key BatchGetItem responses */
const TABLE = "TEST-Contract-Audit";

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

type Case = {
  name: string;
  description: string;
  operation: Operation;
  args: unknown[];
  replies?: Reply[];
};

const record = async ({ name, description, operation, args, replies = [] }: Case) => {
  const { calls, service } = recordingService(replies);

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

// Stored rows, as DynamoDB returns them (marshalled)
const auditRow = (overrides: Record<string, unknown> = {}) => ({
  PK: "App1.Order",
  SK: "audit-1",
  id: "audit-1",
  operation: "createOrder",
  status: "success",
  tier: 2,
  target: { app: "App1", type: "Order", id: "order-1" },
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const storedAudit = (overrides: Record<string, unknown> = {}) =>
  marshall(auditRow(overrides), { removeUndefinedValues: true });

/**
 * A row as an INCLUDE index returns it: the table keys, the index's keys and
 * the listing attributes the CDK table projects.
 */
const indexRow = (indexKeys: string[], overrides: Record<string, unknown>) => {
  const row: Record<string, unknown> = auditRow(overrides);
  const projected = [
    DynamoDB.Keys.PARTITION_KEY,
    DynamoDB.Keys.SORT_KEY,
    ...indexKeys,
    ...DynamoDB.Projections.LISTING,
  ];

  return marshall(
    Object.fromEntries(projected.filter((key) => key in row).map((key) => [key, row[key]])),
  );
};

const traceRow = (overrides: Record<string, unknown> = {}) =>
  indexRow([DynamoDB.Keys.GSI1_SN_PARTITION_KEY, DynamoDB.Keys.GSI1_SN_SORT_KEY], {
    GSI1_SN_PK: "trace-1",
    GSI1_SN_SK: 0,
    ...overrides,
  });

const statusRow = (overrides: Record<string, unknown> = {}) =>
  indexRow([DynamoDB.Keys.GSI2_SS_PARTITION_KEY, DynamoDB.Keys.GSI2_SS_SORT_KEY], {
    GSI2_SS_PK: "fail",
    GSI2_SS_SK: `${NOW}#audit-1`,
    status: "fail",
    ...overrides,
  });

const resourceRow = (overrides: Record<string, unknown> = {}) =>
  indexRow(
    [
      DynamoDB.Keys.GSI1_SS_PARTITION_KEY,
      DynamoDB.Keys.GSI1_SS_SORT_KEY,
      DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
      DynamoDB.Keys.GSI1_SN_SORT_KEY,
    ],
    {
      GSI1_SS_PK: "App1.Order#order-1",
      GSI1_SS_SK: "audit-1",
      GSI1_SN_PK: "trace-1",
      GSI1_SN_SK: 0,
      ...overrides,
    },
  );

const accepted = (count = 1) => ({
  output: {
    FailedEntryCount: 0,
    Entries: Array.from({ length: count }, (_, i) => ({ EventId: `event-${i + 1}` })),
  },
});

const attempts = (count: number) => ({
  output: {
    Attributes: marshall({
      attempts: Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        status: "success",
        at: NOW,
      })),
    }),
  },
});

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
    description: "GetItem by app, type and id; a stored string trace is returned as stored",
    operation: "getItem",
    args: [{ app: "App1", resourceType: "Order", id: "audit-1" }],
    replies: [
      {
        output: { Item: storedAudit({ trace: "trace-1:0", GSI1_SN_PK: "trace-1", GSI1_SN_SK: 0 }) },
      },
    ],
  },
  {
    name: "get-item/trace-from-keys",
    description: "Without a stored trace, the trace is rebuilt from the GSI1_SN keys",
    operation: "getItem",
    args: [{ app: "App1", resourceType: "Order", id: "audit-1" }],
    replies: [{ output: { Item: storedAudit({ GSI1_SN_PK: "trace-1", GSI1_SN_SK: 2 }) } }],
  },
  {
    name: "get-item/tenant",
    description: "A tenant prefixes the partition key and is stripped from the rebuilt trace",
    operation: "getItem",
    args: [{ tenantId: "tenant-1", app: "App1", resourceType: "Order", id: "audit-1" }],
    replies: [
      {
        output: {
          Item: storedAudit({
            PK: "tenant-1#App1.Order",
            GSI1_SN_PK: "tenant-1#trace-1",
            GSI1_SN_SK: 0,
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
    description: "A second write of the same audit numbers its attempt with a follow-up UpdateItem",
    operation: "upsertItem",
    args: [upsertInput({ status: "fail", error: "Still failing" })],
    replies: [attempts(2), { output: {} }, accepted()],
  },
  {
    name: "upsert/tenant",
    description: "A tenant prefixes the partition and index keys",
    operation: "upsertItem",
    args: [upsertInput({ tenantId: "tenant-1", trace: "trace-1" })],
    replies: [attempts(1), accepted()],
  },
  {
    name: "upsert/related-resources",
    description: "Each additional resource gets a copy written with BatchWriteItem",
    operation: "upsertItem",
    args: [
      upsertInput({
        trace: "trace-1",
        resources: [
          { app: "TestApp", type: "User", id: "user-1" },
          { app: "App1", type: "Unknown", id: 7 },
        ],
        event: { source: "orders", "detail-type": "OrderCreated", detail: "{}" },
      }),
    ],
    replies: [attempts(1), { output: {} }, accepted()],
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
      "Audits of a resource type, newest first by tier; LastEvaluatedKey becomes nextToken",
    operation: "listObjects",
    args: [{ app: "App1", resource: { type: "Order" } }],
    replies: [
      {
        output: {
          Items: [storedAudit({ LSI1_N_SK: 21767323445678, trace: "trace-1" })],
          LastEvaluatedKey: marshall({
            PK: "App1.Order",
            SK: "audit-1",
            LSI1_N_SK: 21767323445678,
          }),
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
      {
        pageSize: 2,
        nextToken: encodeNextPageToken({
          PK: "App1.Order",
          SK: "audit-1",
          LSI1_N_SK: 21767323445678,
        }),
      },
    ],
    replies: [{ output: { Items: [] } }],
  },

  // listItems
  {
    name: "list-items/basic",
    description: "Audits of one resource by its id; the trace is rebuilt from index keys",
    operation: "listItems",
    args: [{ app: "App1", resource: { type: "Order", id: "order-1" } }],
    replies: [
      {
        output: {
          Items: [resourceRow()],
        },
      },
    ],
  },

  // listTraceItems
  {
    name: "list-trace/basic",
    description: "Audits of a trace, excluding related-resource copies",
    operation: "listTraceItems",
    args: [{ trace: "trace-1" }],
    replies: [{ output: { Items: [traceRow()] } }],
  },
  {
    name: "list-trace/filtered",
    description: "App and resource filters match the target; copies are not excluded",
    operation: "listTraceItems",
    args: [{ trace: "trace-1", app: "App1", resource: { type: "Order", id: "order-1" } }],
    replies: [{ output: { Items: [traceRow()] } }],
  },
  {
    name: "list-trace/related-copy",
    description:
      "A matching related-resource copy is replaced by its parent, read with BatchGetItem",
    operation: "listTraceItems",
    args: [{ trace: "trace-1", app: "TestApp" }],
    replies: [
      {
        output: {
          Items: [
            traceRow({
              PK: "TestApp.User",
              SK: "audit-1#TestApp.User#user-1",
              target: { app: "TestApp", type: "User", id: "user-1" },
              source: { app: "App1", type: "Order", id: "order-1" },
            }),
          ],
        },
      },
      { output: { Responses: { [TABLE]: [traceRow()] } } },
    ],
  },

  // listByStatus
  {
    name: "list-status/basic",
    description: "Audits with a status, excluding related-resource copies; no trace is emitted",
    operation: "listByStatus",
    args: [{ status: "fail" }],
    replies: [{ output: { Items: [statusRow()] } }],
  },
  {
    name: "list-status/related-parent-on-page",
    description: "A matching copy whose parent is on the page is folded into it without a read",
    operation: "listByStatus",
    args: [{ status: "fail", app: "App1" }],
    replies: [
      {
        output: {
          Items: [
            statusRow(),
            statusRow({
              PK: "App1.Unknown",
              SK: "audit-1#App1.Unknown#7",
              target: { app: "App1", type: "Unknown", id: 7 },
              source: { app: "App1", type: "Order", id: "order-1" },
            }),
          ],
        },
      },
    ],
  },
  {
    name: "list-status/tenant",
    description: "A tenant prefixes the status partition key",
    operation: "listByStatus",
    args: [{ tenantId: "tenant-1", status: "fail" }, { pageSize: 10 }],
    replies: [
      {
        output: {
          Items: [statusRow({ PK: "tenant-1#App1.Order", GSI2_SS_PK: "tenant-1#fail" })],
        },
      },
    ],
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
    args: [
      { status: "fail" },
      {
        nextToken: encodeNextPageToken({
          PK: "App1.Order",
          SK: "audit-1",
          LSI1_N_SK: 21767323445678,
        }),
      },
    ],
    replies: [],
  },
  {
    name: "list-objects/token-wrong-type",
    description: "A nextToken key with the wrong attribute type is refused",
    operation: "listObjects",
    args: [
      { app: "App1", resource: { type: "Order" } },
      {
        nextToken: encodeNextPageToken({
          PK: "App1.Order",
          SK: "audit-1",
          LSI1_N_SK: "21767323445678",
        }),
      },
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
        nextToken: encodeNextPageToken({
          PK: "tenant-1#App1.Order",
          SK: "audit-1",
          GSI2_SS_PK: "tenant-1#warn",
          GSI2_SS_SK: `${NOW}#audit-1`,
        }),
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
      { PK: "tenant-1#App1.Order", SK: "audit-1", LSI1_N_SK: 21767323445678 },
      {
        PK: "App1.Order",
        SK: "audit-1",
        GSI1_SS_PK: "App1.Order#order-1",
        GSI1_SS_SK: "audit-1",
      },
      { PK: "App1.Order", SK: "audit-1", GSI1_SN_PK: "trace-1", GSI1_SN_SK: 2 },
      { PK: "App1.Order", SK: "audit-1", GSI2_SS_PK: "fail", GSI2_SS_SK: `${NOW}#audit-1` },
    ];
    const tokens = keys.map((key) => {
      const token = encodeNextPageToken(key);
      return { key, token, decoded: decodeNextPageToken(token) };
    });

    await expect(
      `${JSON.stringify({ description: "nextToken encoding (encodeNextPageToken)", tokens }, null, 2)}\n`,
    ).toMatchFileSnapshot(`${FIXTURES}/pagination-tokens.json`);
  });
});
