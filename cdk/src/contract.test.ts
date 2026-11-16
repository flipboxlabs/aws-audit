/**
 * Records the REST handlers' contract for the Rust port (#93) under `contract/`:
 *
 * - `fixtures/http`: a request, the AWS calls the handler made (input and the
 *   response fed back), and the HTTP response it answered.
 * - `schemas`: JSON Schema 2020-12 for each route's path, query and response,
 *   generated from the handlers' zod schemas.
 * - `fixtures/layer`: the `audit-config.json` the config layer writes for Rust
 *   Lambdas.
 *
 * Handlers run for real on recording AWS clients; only the clients' `send` is
 * replaced. The committed files are file snapshots, so this test fails when a
 * handler's behavior drifts from them. Regenerate with `pnpm contract:update`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { APIGatewayProxyEvent, Context } from "aws-lambda";
import * as cdk from "aws-cdk-lib";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { testConfig } from "./test-config.js";

const FIXTURES = "../../contract/fixtures/http";
const SCHEMAS = "../../contract/schemas";
const LAYER = "../../contract/fixtures/layer";

/** Fixed clock for any time the handlers or SDK read */
const NOW = "2026-01-02T03:04:05.678Z";

type Call = {
  service: "DynamoDB" | "EventBridge";
  command: string;
  input: unknown;
  output?: unknown;
  error?: { name: string; message: string };
};

type Reply = { output: unknown } | { error: { name: string; message: string } };

const recorder = vi.hoisted(() => {
  // Read by the handlers at import, so set before any of them load
  Object.assign(process.env, {
    ENVIRONMENT: "test",
    SERVICE: "Contract",
    AWS_REGION: "us-east-1",
    AWS_AUDIT_CDK_VERSION: "0.0.0-contract",
    POWERTOOLS_LOG_LEVEL: "SILENT",
    POWERTOOLS_DEV: "false",
  });

  const state = { calls: [] as Call[], queue: [] as Reply[] };

  const send =
    (service: Call["service"]) =>
    async (command: { constructor: { name: string }; input: unknown }) => {
      const call: Call = {
        service,
        command: command.constructor.name.replace(/Command$/, ""),
        input: structuredClone(command.input),
      };
      state.calls.push(call);

      const reply = state.queue.shift() ?? { output: {} };
      if ("error" in reply) {
        call.error = reply.error;
        throw Object.assign(new Error(reply.error.message), { name: reply.error.name });
      }

      call.output = reply.output;
      return structuredClone(reply.output);
    };

  return { state, send };
});

vi.mock("./audit-config.js", () => ({ auditConfig: testConfig }));

vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-dynamodb")>()),
  DynamoDBClient: class RecordingDynamoDBClient {
    send = recorder.send("DynamoDB");
  },
}));

vi.mock("@aws-sdk/client-eventbridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-eventbridge")>()),
  EventBridgeClient: class RecordingEventBridgeClient {
    send = recorder.send("EventBridge");
  },
}));

import { handler as configHandler } from "./rest-api/resources/config/handler.js";
import * as configSchema from "./rest-api/resources/config/schema.js";
import { handler as statusHandler } from "./rest-api/resources/status/handler.js";
import * as statusSchema from "./rest-api/resources/status/schema.js";
import { handler as traceHandler } from "./rest-api/resources/trace/handler.js";
import * as traceSchema from "./rest-api/resources/trace/schema.js";
import { handler as objectsHandler } from "./rest-api/resources/app/resources/objects/handler.js";
import * as objectsSchema from "./rest-api/resources/app/resources/objects/schema.js";
import { handler as rerunHandler } from "./rest-api/resources/app/resources/objects/resources/rerun/handler.js";
import * as rerunSchema from "./rest-api/resources/app/resources/objects/resources/rerun/schema.js";
import { ConfigLayerConstruct } from "./lambda/construct.js";

type Handler = (event: unknown, context: Context) => Promise<unknown>;

/** API Gateway resource paths, as the REST API routes them to each Lambda */
const ROUTES = {
  config: { resource: "/config", handler: configHandler },
  status: { resource: "/status/{status}", handler: statusHandler },
  trace: { resource: "/trace/{trace}", handler: traceHandler },
  objects: { resource: "/apps/{app}/objects/{object}", handler: objectsHandler },
  items: { resource: "/apps/{app}/objects/{object}/{item}", handler: objectsHandler },
  detail: { resource: "/apps/{app}/objects/{object}/{item}/{audit}", handler: objectsHandler },
  rerun: { resource: "/apps/{app}/objects/{object}/{item}/{audit}/rerun", handler: rerunHandler },
} satisfies Record<string, { resource: string; handler: Handler }>;

type Route = keyof typeof ROUTES;

type Request = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
};

type Case = {
  name: string;
  description: string;
  route: Route;
  request: Request;
  replies?: Reply[];
};

const context = {
  functionName: "contract",
  awsRequestId: "request-id",
  getRemainingTimeInMillis: () => 10_000,
} as unknown as Context;

/** Builds the API Gateway REST (v1) proxy event the Lambda receives */
const proxyEvent = (route: Route, { method, path, query }: Request): APIGatewayProxyEvent => {
  const { resource } = ROUTES[route];
  const names = [...resource.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
  const pattern = new RegExp(`^${resource.replace(/\{\w+\}/g, "([^/]+)")}$`);
  const values = pattern.exec(path)?.slice(1) ?? [];

  return {
    resource,
    path,
    httpMethod: method,
    headers: { accept: "application/json" },
    multiValueHeaders: { accept: ["application/json"] },
    pathParameters: names.length
      ? Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(values[i])]))
      : null,
    queryStringParameters: query ?? null,
    multiValueQueryStringParameters: query
      ? Object.fromEntries(Object.entries(query).map(([key, value]) => [key, [value]]))
      : null,
    stageVariables: null,
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: "123456789012",
      apiId: "contract",
      httpMethod: method,
      path: `/test${path}`,
      protocol: "HTTP/1.1",
      requestId: "request-id",
      requestTimeEpoch: Date.parse(NOW),
      resourceId: "resource",
      resourcePath: resource,
      stage: "test",
      identity: { sourceIp: "127.0.0.1", userAgent: "contract" },
    },
  } as unknown as APIGatewayProxyEvent;
};

const record = async ({ name, description, route, request, replies = [] }: Case) => {
  recorder.state.calls = [];
  recorder.state.queue = [...replies];

  const result = (await ROUTES[route].handler(proxyEvent(route, request), context)) as {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
  };

  const fixture = {
    description,
    route: `${request.method} ${ROUTES[route].resource}`,
    request,
    calls: recorder.state.calls,
    response: {
      statusCode: result.statusCode,
      contentType: result.headers?.["content-type"] ?? null,
      body: result.body ? JSON.parse(result.body) : null,
    },
  };

  await expect(`${JSON.stringify(fixture, null, 2)}\n`).toMatchFileSnapshot(
    `${FIXTURES}/${name}.json`,
  );
};

// Stored rows, as DynamoDB returns them (marshalled)
const auditRow = (overrides: Record<string, unknown> = {}) =>
  marshall(
    {
      PK: "App1.Order",
      SK: "audit-1",
      id: "audit-1",
      operation: "createOrder",
      status: "fail",
      tier: 2,
      target: { app: "App1", type: "Order", id: "order-1" },
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    },
    { removeUndefinedValues: true },
  );

const rerunableRow = (overrides: Record<string, unknown> = {}) =>
  auditRow({
    rerunable: true,
    event: {
      source: "orders",
      "detail-type": "OrderCreated",
      detail: '{"orderId":"order-1", "n":1.0}',
    },
    ...overrides,
  });

const CASES: Case[] = [
  {
    name: "config/get",
    description: "Configured apps and resource types, and the package version",
    route: "config",
    request: { method: "GET", path: "/config" },
  },

  // status
  {
    name: "status/list",
    description: "Audits with a status",
    route: "status",
    request: { method: "GET", path: "/status/fail" },
    replies: [
      {
        output: {
          Items: [auditRow({ GSI2_SS_PK: "fail", GSI2_SS_SK: `${NOW}#audit-1` })],
          LastEvaluatedKey: marshall({
            PK: "App1.Order",
            SK: "audit-1",
            GSI2_SS_PK: "fail",
            GSI2_SS_SK: `${NOW}#audit-1`,
          }),
        },
      },
    ],
  },
  {
    name: "status/list-filtered",
    description: "Pagination and filters come from bracketed query parameters",
    route: "status",
    request: {
      method: "GET",
      path: "/status/fail",
      query: {
        "pagination[pageSize]": "5",
        "filter[app]": "App1",
        "filter[resourceType]": "Order",
      },
    },
    replies: [{ output: { Items: [] } }],
  },
  {
    name: "status/invalid-status",
    description: "A status outside the enum is a 422",
    route: "status",
    request: { method: "GET", path: "/status/unknown" },
  },
  {
    name: "status/invalid-filter",
    description: "An app outside the config is a 422",
    route: "status",
    request: { method: "GET", path: "/status/fail", query: { "filter[app]": "Nope" } },
  },
  {
    name: "status/invalid-page-size",
    description: "A pageSize that isn't a positive integer is a 422",
    route: "status",
    request: { method: "GET", path: "/status/fail", query: { "pagination[pageSize]": "-1" } },
  },
  {
    name: "status/page-size-too-large",
    description: "A pageSize over the maximum is a 422",
    route: "status",
    request: { method: "GET", path: "/status/fail", query: { "pagination[pageSize]": "1001" } },
  },
  {
    name: "status/invalid-token",
    description: "A nextToken the listing didn't issue is a 422, without querying",
    route: "status",
    request: {
      method: "GET",
      path: "/status/fail",
      query: { "pagination[nextToken]": "not-a-token" },
    },
  },
  {
    name: "status/storage-error",
    description: "A DynamoDB failure is a logged 500",
    route: "status",
    request: { method: "GET", path: "/status/fail" },
    replies: [{ error: { name: "ProvisionedThroughputExceededException", message: "Slow down" } }],
  },

  // trace
  {
    name: "trace/list",
    description: "Audits of a trace; trace is rebuilt from the index keys",
    route: "trace",
    request: { method: "GET", path: "/trace/trace-1", query: { "filter[app]": "App1" } },
    replies: [{ output: { Items: [auditRow({ GSI1_SN_PK: "trace-1", GSI1_SN_SK: 1 })] } }],
  },

  // objects
  {
    name: "objects/list",
    description: "Audits of a resource type",
    route: "objects",
    request: { method: "GET", path: "/apps/App1/objects/Order" },
    replies: [{ output: { Items: [auditRow({ LSI1_N_SK: 21767323445678, trace: "trace-1:0" })] } }],
  },
  {
    name: "objects/invalid-app",
    description: "An app outside the config is a 422",
    route: "objects",
    request: { method: "GET", path: "/apps/Nope/objects/Order" },
  },
  {
    name: "objects/items",
    description: "Audits of one resource",
    route: "items",
    request: { method: "GET", path: "/apps/App1/objects/Order/order-1" },
    replies: [
      {
        output: {
          Items: [auditRow({ GSI1_SS_PK: "App1.Order#order-1", GSI1_SS_SK: "audit-1" })],
        },
      },
    ],
  },
  {
    name: "objects/detail",
    description: "One audit; event, attempts and error are included",
    route: "detail",
    request: { method: "GET", path: "/apps/App1/objects/Order/order-1/audit-1" },
    replies: [
      {
        output: {
          Item: rerunableRow({
            trace: "trace-1:2",
            error: "Boom",
            attempts: [{ number: 1, status: "fail", error: "Boom", at: NOW }],
          }),
        },
      },
    ],
  },
  {
    name: "objects/detail-not-found",
    description: "A missing audit is a 404",
    route: "detail",
    request: { method: "GET", path: "/apps/App1/objects/Order/order-1/missing" },
    replies: [{ output: {} }],
  },
  {
    name: "objects/detail-other-item",
    description: "An audit of another item is the same 404 as a missing one",
    route: "detail",
    request: { method: "GET", path: "/apps/App1/objects/Order/order-2/audit-1" },
    replies: [{ output: { Item: auditRow() } }],
  },

  // rerun
  {
    name: "rerun/sent",
    description: "The stored event is re-sent with its detail string as stored; 204",
    route: "rerun",
    request: { method: "POST", path: "/apps/App1/objects/Order/order-1/audit-1/rerun" },
    replies: [
      { output: { Item: rerunableRow() } },
      { output: { FailedEntryCount: 0, Entries: [{ EventId: "event-1" }] } },
    ],
  },
  {
    name: "rerun/not-rerunable",
    description: "An audit without an event is a 400 and nothing is sent",
    route: "rerun",
    request: { method: "POST", path: "/apps/App1/objects/Order/order-1/audit-1/rerun" },
    replies: [{ output: { Item: auditRow() } }],
  },
  {
    name: "rerun/not-found",
    description: "A missing audit is a 404 and nothing is sent",
    route: "rerun",
    request: { method: "POST", path: "/apps/App1/objects/Order/order-1/missing/rerun" },
    replies: [{ output: {} }],
  },
  {
    name: "rerun/rejected",
    description: "A rejected entry is a 500, without a retry",
    route: "rerun",
    request: { method: "POST", path: "/apps/App1/objects/Order/order-1/audit-1/rerun" },
    replies: [
      { output: { Item: rerunableRow() } },
      {
        output: {
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }],
        },
      },
    ],
  },
];

/** Each route's request and response schemas, by the file name they're written to */
const SCHEMA_FILES = {
  "config.response": configSchema.ResponseSchema,
  "status.path": statusSchema.PathSchema,
  "status.query": statusSchema.QuerySchema,
  "status.response": statusSchema.ResponseCollectionSchema,
  "trace.path": traceSchema.PathSchema,
  "trace.query": traceSchema.QuerySchema,
  "trace.response": traceSchema.ResponseCollectionSchema,
  "objects.path": objectsSchema.ObjectPathSchema,
  "objects.query": objectsSchema.QuerySchema,
  "objects.response": objectsSchema.ResponseCollectionSchema,
  "items.path": objectsSchema.PathSchema,
  "items.query": objectsSchema.QuerySchema,
  "items.response": objectsSchema.ResponseCollectionSchema,
  "detail.path": objectsSchema.DetailPathSchema,
  "detail.response": objectsSchema.ResponseDetailSchema,
  "rerun.path": rerunSchema.PathSchema,
} satisfies Record<string, z.ZodType>;

describe("contract", () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe("http fixtures", () => {
    it.each(CASES)("$name", async (fixture) => {
      await record(fixture);
    });
  });

  describe("schemas", () => {
    it.each(Object.entries(SCHEMA_FILES))("%s", async (name, schema) => {
      // Requests are validated as received, responses as sent
      const io = name.endsWith(".response") ? "output" : "input";
      const jsonSchema = z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io,
        unrepresentable: "any",
      });

      await expect(`${JSON.stringify(jsonSchema, null, 2)}\n`).toMatchFileSnapshot(
        `${SCHEMAS}/${name}.schema.json`,
      );
    });
  });

  describe("layer", () => {
    it("audit-config.json", async () => {
      const app = new cdk.App();
      new ConfigLayerConstruct(new cdk.Stack(app, "Contract"), "AuditConfigLayer", {
        apps: testConfig.apps,
        resourceTypes: testConfig.resourceTypes,
      });

      const { directory } = app.synth();
      const [asset] = fs.readdirSync(directory).filter((entry) => entry.startsWith("asset."));

      // Byte for byte as Lambda will find it at /opt/audit-config.json
      await expect(
        fs.readFileSync(path.join(directory, asset, "audit-config.json"), "utf8"),
      ).toMatchFileSnapshot(`${LAYER}/audit-config.json`);
    });
  });
});
