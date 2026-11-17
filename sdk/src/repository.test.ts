import type { Logger } from "@aws-lambda-powertools/logger";
import {
  BatchWriteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DynamoDB } from "./constants.js";
import { InvalidNextTokenError, InvalidResourceFilterError } from "./errors.js";
import {
  AuditRepository,
  filterScope,
  resourceScopes,
  type TypedListByStatusOptions,
  type TypedListItemsOptions,
  type TypedListObjectsOptions,
  type TypedListTraceItems,
} from "./repository.js";
import { encodeNextPageToken } from "./repository.utils.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { App, ResourceType, testConfig } from "./test-config.js";

type ListItemsOptions = TypedListItemsOptions<typeof testConfig>;
type ListObjectsOptions = TypedListObjectsOptions<typeof testConfig>;
type ListTraceItems = TypedListTraceItems<typeof testConfig>;
type ListByStatusOptions = TypedListByStatusOptions<typeof testConfig>;

// Mock the DynamoDB client
vi.mock("@aws-sdk/client-dynamodb", async () => {
  const actual = await vi.importActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: class MockDynamoDBClient {
      send = vi.fn();
    },
  };
});

const TABLE = DynamoDB.Table.Name();
const CREATED_AT = "2026-01-02T03:04:05.678Z";

describe("AuditRepository", () => {
  let mockClient: {
    send: ReturnType<typeof vi.fn>;
  };
  let mockLogger: {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let repository: AuditRepository<typeof testConfig>;

  /** An audit as the table stores it */
  const storedAudit = (overrides: Record<string, unknown> = {}) => ({
    PK: `${App.App1}.${ResourceType.ORDER}#audit-123`,
    SK: "audit",
    id: "audit-123",
    operation: "createOrder",
    status: "fail",
    tier: 1,
    target: { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
    trace: "trace-1:2",
    error: "Boom",
    attempts: [{ number: 1, status: "fail", at: CREATED_AT }],
    updatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    tenantKey: "-",
    app: App.App1,
    resourceType: ResourceType.ORDER,
    resourceId: "order-1",
    kind: "audit",
    traceId: "trace-1",
    traceStage: 2,
    scopes: new Set(["App1", "App1.Order", "*.Order", "App1.Order#order-1"]),
    ttl: 1775099045,
    ...overrides,
  });

  /** What a listing index returns for that audit: its keys and the summary */
  const indexRow = (overrides: Record<string, unknown> = {}) => {
    const { error: _, attempts: __, scopes: ___, ttl: ____, ...row } = storedAudit(overrides);
    return row;
  };

  const upsertInput = (
    overrides: Partial<UpsertAuditInput> = {},
  ): UpsertAuditInput & { id: string } =>
    ({
      id: "audit-123",
      operation: "createOrder",
      status: "fail",
      tier: 1,
      target: { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
      ...overrides,
    }) as UpsertAuditInput & { id: string };

  const attempt = { number: 1, status: "fail", at: CREATED_AT };

  /** The UpdateItem response for a first attempt */
  const updated = (attempts = [attempt], createdAt = CREATED_AT) => ({
    Attributes: marshall({ attempts, createdAt }),
  });

  /** The names and values an UpdateItem sets, unmarshalled */
  const setValues = (command: UpdateItemCommand) => {
    const { ExpressionAttributeNames: names = {}, ExpressionAttributeValues: values = {} } =
      command.input;
    const plain = unmarshall(values);
    return Object.fromEntries(
      Object.entries(names).map(([token, name]) => [name, plain[`:${token.slice(1)}`]]),
    );
  };

  const queryInput = (call = 0) => (mockClient.send.mock.calls[call][0] as QueryCommand).input;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockClient = {
      send: vi.fn(),
    };

    repository = new AuditRepository(
      mockLogger as unknown as Logger,
      testConfig,
      mockClient as unknown as DynamoDBClient,
    );
  });

  describe("constructor", () => {
    it("should create default client when not provided", () => {
      const repoWithDefaults = new AuditRepository(mockLogger as unknown as Logger, testConfig);

      expect(repoWithDefaults).toBeInstanceOf(AuditRepository);
    });
  });

  describe("getItem", () => {
    const identifiers = { id: "audit-123", app: App.App1, resourceType: ResourceType.ORDER };

    it("should read the audit's item", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.getItem(identifiers);

      const command = mockClient.send.mock.calls[0][0] as GetItemCommand;
      expect(command).toBeInstanceOf(GetItemCommand);
      expect(command.input).toEqual({
        TableName: TABLE,
        Key: marshall({ PK: "App1.Order#audit-123", SK: "audit" }),
      });
    });

    it("should prefix the partition key with the tenant", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.getItem({ ...identifiers, tenantId: "tenant-a" });

      const command = mockClient.send.mock.calls[0][0] as GetItemCommand;
      expect(command.input.Key).toEqual(
        marshall({ PK: "tenant-a#App1.Order#audit-123", SK: "audit" }),
      );
    });

    it("should return undefined when the item doesn't exist", async () => {
      mockClient.send.mockResolvedValue({});

      await expect(repository.getItem(identifiers)).resolves.toBeUndefined();
    });

    it("should return the whole audit without its storage attributes", async () => {
      mockClient.send.mockResolvedValue({ Item: marshall(storedAudit()) });

      const audit = await repository.getItem(identifiers);

      expect(audit).toEqual({
        id: "audit-123",
        operation: "createOrder",
        status: "fail",
        tier: 1,
        target: { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
        trace: "trace-1:2",
        error: "Boom",
        attempts: [{ number: 1, status: "fail", at: CREATED_AT }],
        updatedAt: new Date(CREATED_AT),
        createdAt: new Date(CREATED_AT),
      });
    });

    it("should omit a trace stored as NULL", async () => {
      mockClient.send.mockResolvedValue({ Item: marshall(storedAudit({ trace: null })) });

      const audit = await repository.getItem(identifiers);

      expect(audit).not.toHaveProperty("trace");
    });

    it("should log and rethrow DynamoDB errors", async () => {
      const error = new Error("DynamoDB error");
      mockClient.send.mockRejectedValue(error);

      await expect(repository.getItem(identifiers)).rejects.toBe(error);
      expect(mockLogger.error).toHaveBeenCalledWith("Failed to read audit item", {
        identifiers,
        error,
      });
    });

    it("should log and rethrow when the item fails schema parsing", async () => {
      mockClient.send.mockResolvedValue({
        Item: marshall(storedAudit({ target: "not-a-resource" })),
      });

      await expect(repository.getItem(identifiers)).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to read audit item",
        expect.objectContaining({ error: expect.any(Error) }),
      );
    });
  });

  describe("upsertItem", () => {
    it("should update the audit's item and return the attempt and stored createdAt", async () => {
      mockClient.send.mockResolvedValue(updated([attempt], "2025-12-31T00:00:00.000Z"));

      const result = await repository.upsertItem(upsertInput(), attempt);

      expect(result).toEqual({ attemptNumber: 1, createdAt: "2025-12-31T00:00:00.000Z" });
      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command).toBeInstanceOf(UpdateItemCommand);
      expect(command.input.TableName).toBe(TABLE);
      expect(command.input.Key).toEqual(marshall({ PK: "App1.Order#audit-123", SK: "audit" }));
      expect(command.input.ReturnValues).toBe("ALL_NEW");
    });

    it("should append the attempt and keep the first createdAt", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput(), attempt);

      const { UpdateExpression } = (mockClient.send.mock.calls[0][0] as UpdateItemCommand).input;
      expect(UpdateExpression).toContain(
        "#attempts = list_append(if_not_exists(#attempts, :emptyList), :newAttempt)",
      );
      expect(UpdateExpression).toContain("#createdAt = if_not_exists(#createdAt, :createdAt)");
    });

    it("should add to the audit's scopes, keeping those of resources a retry dropped", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput(), attempt);

      const { UpdateExpression } = (mockClient.send.mock.calls[0][0] as UpdateItemCommand).input;
      expect(UpdateExpression).toMatch(/ ADD #scopes :scopes$/);
      expect(UpdateExpression).not.toContain("#scopes = :scopes");
    });

    it("should set the attributes the indexes are keyed on", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(
        upsertInput({
          trace: "trace-1:2",
          resources: [
            { app: App.TestApp, type: ResourceType.USER, id: 7 },
            { app: App.App1, type: ResourceType.USER },
          ],
        }),
        attempt,
      );

      const values = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(values).toMatchObject({
        tenantKey: "-",
        app: "App1",
        resourceType: "Order",
        resourceId: "order-1",
        kind: "audit",
        traceId: "trace-1",
        traceStage: 2,
        scopes: new Set([
          "App1",
          "App1.Order",
          "*.Order",
          "App1.Order#order-1",
          "TestApp",
          "TestApp.User",
          "*.User",
          "TestApp.User#7",
          "App1.User",
        ]),
      });
    });

    it("should key a tenant's audit by its tenant", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput({ tenantId: "tenant-a" }), attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.Key).toEqual(
        marshall({ PK: "tenant-a#App1.Order#audit-123", SK: "audit" }),
      );
      expect(setValues(command)).toMatchObject({ tenantKey: "tenant-a", tenantId: "tenant-a" });
    });

    it("should store a numeric resource id as a string", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(
        upsertInput({ target: { app: App.App1, type: ResourceType.ORDER, id: 0 } }),
        attempt,
      );

      const values = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(values.resourceId).toBe("0");
      expect(values.target).toEqual({ app: "App1", type: "Order", id: 0 });
    });

    it("should leave out the resource id and trace attributes when there are none", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(
        upsertInput({ target: { app: App.App1, type: ResourceType.ORDER } }),
        attempt,
      );

      const values = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(values).not.toHaveProperty("resourceId");
      expect(values).not.toHaveProperty("traceId");
      expect(values).not.toHaveProperty("traceStage");
      expect(values.scopes).toEqual(new Set(["App1", "App1.Order", "*.Order"]));
    });

    it("should use stage 0 for a trace without a stage", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput({ trace: "trace-1" }), attempt);

      const values = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(values).toMatchObject({ trace: "trace-1", traceId: "trace-1", traceStage: 0 });
    });

    it("should set the TTL from the configured seconds", async () => {
      mockClient.send.mockResolvedValue(updated());
      const { defineAuditConfig } = await import("./config.js");
      const customRepo = new AuditRepository(
        mockLogger as unknown as Logger,
        defineAuditConfig({
          apps: ["App1", "TestApp"] as const,
          resourceTypes: ["Unknown", "User", "Order"] as const,
          ttlSeconds: 60,
        }),
        mockClient as unknown as DynamoDBClient,
      );

      const before = Math.floor(Date.now() / 1000);
      await customRepo.upsertItem(upsertInput(), attempt);
      const after = Math.floor(Date.now() / 1000);

      const { ttl } = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(ttl).toBeGreaterThanOrEqual(before + 60);
      expect(ttl).toBeLessThanOrEqual(after + 60);
    });

    it("should add the default 90-day TTL in epoch seconds across a daylight saving change", async () => {
      // 90 days from January 2 crosses the March change in America/Denver
      vi.stubEnv("TZ", "America/Denver");
      vi.useFakeTimers({ now: new Date(CREATED_AT), toFake: ["Date"] });
      mockClient.send.mockResolvedValue(updated());

      try {
        await repository.upsertItem(upsertInput(), attempt);
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }

      // 2026-04-02T03:04:05Z
      expect(setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand).ttl).toBe(1775099045);
    });

    it("should throw when UpdateItem returns no attributes", async () => {
      mockClient.send.mockResolvedValue({});

      await expect(repository.upsertItem(upsertInput(), attempt)).rejects.toThrow(
        "UpdateItem did not return attributes",
      );
    });

    it("should renumber a retry on an existing item and ignore caller-supplied attempts", async () => {
      const retry = { number: 1, status: "success", at: "2026-01-03T00:00:00.000Z" };
      mockClient.send.mockResolvedValue(
        updated([
          { number: 1, status: "fail", at: "2026-01-01T00:00:00.000Z" },
          { number: 2, status: "fail", at: "2026-01-02T00:00:00.000Z" },
          retry,
        ]),
      );

      const result = await repository.upsertItem(
        upsertInput({ attempts: [{ number: 9, status: "fail", at: "2023-12-31T00:00:00Z" }] }),
        retry,
      );

      expect(result.attemptNumber).toBe(3);
      expect(mockClient.send).toHaveBeenCalledTimes(2);

      const [update, renumber] = mockClient.send.mock.calls.map(
        ([command]) => (command as UpdateItemCommand).input,
      );
      expect(update.ExpressionAttributeValues).not.toHaveProperty(":attempts");
      expect(update.ExpressionAttributeValues?.[":newAttempt"]).toEqual(marshall({ v: [retry] }).v);

      expect(renumber.Key).toEqual(update.Key);
      expect(renumber.UpdateExpression).toBe("SET #attempts[2].#number = :attemptNumber");
      expect(renumber.ExpressionAttributeNames).toEqual({
        "#attempts": "attempts",
        "#number": "number",
      });
      expect(renumber.ExpressionAttributeValues).toEqual({ ":attemptNumber": { N: "3" } });

      // The caller's attempt (number 9, 2023-12-31) reaches neither request
      for (const input of [update, renumber]) {
        expect(JSON.stringify(input)).not.toContain("2023-12-31");
      }
    });

    it.each<[string, Partial<UpsertAuditInput>]>([
      ["minimal", {}],
      [
        "full",
        {
          id: "audit-full",
          message: "Full input",
          rerunable: true,
          trace: "trace-123:2",
          source: { app: App.App1, type: ResourceType.USER, id: "user-1" },
          context: { region: "us-east-1", nested: { count: 2 } },
          event: { source: "test.service", "detail-type": "Tested", detail: { a: 1 } },
          error: "Connection timeout",
          attempts: [{ number: 1, status: "fail", at: "2023-12-31T00:00:00Z" }],
          createdAt: "2023-12-31T00:00:00.000Z",
          resources: [{ app: App.TestApp, type: ResourceType.USER, id: "user-2" }],
        },
      ],
      ["tenant", { tenantId: "tenant-abc" }],
    ])(
      "should only send expression names and values the update expression uses (%s)",
      async (_label, overrides) => {
        mockClient.send.mockResolvedValue(updated());

        await repository.upsertItem(upsertInput(overrides), attempt);

        const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } = (
          mockClient.send.mock.calls[0][0] as UpdateItemCommand
        ).input;
        const tokens = new Set(UpdateExpression?.match(/[#:][A-Za-z0-9_]+/g));

        // DynamoDB rejects names or values the expression doesn't use, and vice versa
        expect(new Set(Object.keys(ExpressionAttributeNames ?? {}))).toEqual(
          new Set([...tokens].filter((token) => token.startsWith("#"))),
        );
        expect(new Set(Object.keys(ExpressionAttributeValues ?? {}))).toEqual(
          new Set([...tokens].filter((token) => token.startsWith(":"))),
        );
      },
    );
  });

  describe("upsertRelated", () => {
    const putItems = (call = 0) =>
      (mockClient.send.mock.calls[call][0] as BatchWriteItemCommand).input.RequestItems?.[
        TABLE
      ]?.map((request) => unmarshall(request.PutRequest?.Item ?? {}));

    it("should write a summary copy per related resource with an id", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.upsertRelated(
        upsertInput({
          trace: "trace-1:2",
          message: "Order failed",
          event: { source: "orders", "detail-type": "OrderCreated", detail: {} },
          error: "Boom",
          context: { region: "us-east-1" },
          resources: [
            { app: App.TestApp, type: ResourceType.USER, id: 7 },
            { app: App.App1, type: ResourceType.USER },
          ],
        }),
        "2025-12-31T00:00:00.000Z",
      );

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      const [copy, ...rest] = putItems() ?? [];
      expect(rest).toEqual([]);
      expect(copy).toEqual({
        PK: "App1.Order#audit-123",
        SK: "related#TestApp.User#7",
        id: "audit-123",
        operation: "createOrder",
        status: "fail",
        tier: 1,
        message: "Order failed",
        trace: "trace-1:2",
        target: { app: "TestApp", type: "User", id: 7 },
        source: { app: "App1", type: "Order", id: "order-1" },
        rerunable: true,
        createdAt: "2025-12-31T00:00:00.000Z",
        updatedAt: expect.any(String),
        tenantKey: "-",
        app: "TestApp",
        resourceType: "User",
        resourceId: "7",
        kind: "related",
        ttl: expect.any(Number),
      });
    });

    it("should key a tenant's copies under its audit", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.upsertRelated(
        upsertInput({
          tenantId: "tenant-a",
          resources: [{ app: App.TestApp, type: ResourceType.USER, id: "u" }],
        }),
        CREATED_AT,
      );

      expect(putItems()?.[0]).toMatchObject({
        PK: "tenant-a#App1.Order#audit-123",
        tenantId: "tenant-a",
        tenantKey: "tenant-a",
      });
    });

    it("should keep the audit's rerunable setting", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.upsertRelated(
        upsertInput({
          rerunable: false,
          event: { source: "orders", "detail-type": "OrderCreated", detail: {} },
          resources: [{ app: App.TestApp, type: ResourceType.USER, id: "u" }],
        }),
        CREATED_AT,
      );

      expect(putItems()?.[0].rerunable).toBe(false);
    });

    it("should write nothing without related resources that have an id", async () => {
      await repository.upsertRelated(
        upsertInput({ resources: [{ app: App.TestApp, type: ResourceType.USER }] }),
        CREATED_AT,
      );
      await repository.upsertRelated(upsertInput(), CREATED_AT);

      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it("should write one copy per resource, from its last listing", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.upsertRelated(
        upsertInput({
          resources: [
            { app: App.TestApp, type: ResourceType.USER, id: 1 },
            { app: App.TestApp, type: ResourceType.ORDER, id: "o" },
            { app: App.TestApp, type: ResourceType.USER, id: "1" },
          ],
        }),
        CREATED_AT,
      );

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(putItems()?.map(({ SK, target }) => ({ SK, target }))).toEqual([
        { SK: "related#TestApp.User#1", target: { app: "TestApp", type: "User", id: "1" } },
        { SK: "related#TestApp.Order#o", target: { app: "TestApp", type: "Order", id: "o" } },
      ]);
    });

    it("should write 25 copies at a time", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.upsertRelated(
        upsertInput({
          resources: Array.from({ length: 26 }, (_, id) => ({
            app: App.TestApp,
            type: ResourceType.USER,
            id,
          })),
        }),
        CREATED_AT,
      );

      expect(putItems(0)).toHaveLength(25);
      expect(putItems(1)).toHaveLength(1);
    });

    describe("unprocessed items", () => {
      const resources = [{ app: App.TestApp, type: ResourceType.USER, id: "u" }];
      const unprocessed = { [TABLE]: [{ PutRequest: { Item: marshall({ id: "x" }) } }] };

      it("should resend them with a warning", async () => {
        vi.useFakeTimers();
        mockClient.send
          .mockResolvedValueOnce({ UnprocessedItems: unprocessed })
          .mockResolvedValueOnce({ UnprocessedItems: {} });

        try {
          const promise = repository.upsertRelated(upsertInput({ resources }), CREATED_AT);
          await vi.runAllTimersAsync();
          await promise;
        } finally {
          vi.useRealTimers();
        }

        expect(mockClient.send).toHaveBeenCalledTimes(2);
        expect(
          (mockClient.send.mock.calls[1][0] as BatchWriteItemCommand).input.RequestItems,
        ).toEqual(unprocessed);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          "BatchWriteItem: retrying unprocessed items",
          expect.objectContaining({ attempt: 1, count: 1 }),
        );
      });

      it("should throw and log when they remain after the maximum retries", async () => {
        vi.useFakeTimers();
        mockClient.send.mockResolvedValue({ UnprocessedItems: unprocessed });

        try {
          const promise = repository.upsertRelated(upsertInput({ resources }), CREATED_AT);
          const rejection = expect(promise).rejects.toThrow(
            "BatchWriteItem failed: unprocessed items after 8 retries",
          );
          await vi.runAllTimersAsync();
          await rejection;
        } finally {
          vi.useRealTimers();
        }

        expect(mockLogger.warn).toHaveBeenCalledTimes(8);
        expect(mockLogger.error).toHaveBeenCalledWith(
          "BatchWriteItem: unprocessed items remain after max retries",
          expect.objectContaining({ attempt: 9, unprocessed }),
        );
      });
    });
  });

  describe("listings", () => {
    const keyCondition = (input: QueryCommand["input"]) => {
      const names = input.ExpressionAttributeNames ?? {};
      const values = unmarshall(input.ExpressionAttributeValues ?? {});
      return Object.fromEntries(
        (input.KeyConditionExpression ?? "")
          .split(" AND ")
          .map((condition) => condition.split(" = "))
          .map(([name, value]) => [names[name], values[value]]),
      );
    };

    type Listing = {
      name: string;
      index: string;
      forward: boolean;
      partition: Record<string, string>;
      list: (
        repository: AuditRepository<typeof testConfig>,
        extra?: Record<string, unknown>,
        pagination?: { pageSize?: number; nextToken?: string },
      ) => Promise<unknown>;
    };

    const LISTINGS: Listing[] = [
      {
        name: "listObjects",
        index: "ByType",
        forward: false,
        partition: { tenantKey: "-", app: "App1", resourceType: "Order" },
        list: (repo, extra, pagination) =>
          repo.listObjects(
            {
              app: App.App1,
              resource: { type: ResourceType.ORDER },
              ...extra,
            } as ListObjectsOptions,
            pagination,
          ),
      },
      {
        name: "listItems",
        index: "ByResource",
        forward: false,
        partition: { tenantKey: "-", app: "App1", resourceType: "Order", resourceId: "order-1" },
        list: (repo, extra, pagination) =>
          repo.listItems(
            {
              app: App.App1,
              resource: { type: ResourceType.ORDER, id: "order-1" },
              ...extra,
            } as ListItemsOptions,
            pagination,
          ),
      },
      {
        name: "listByStatus",
        index: "ByStatus",
        forward: false,
        partition: { tenantKey: "-", status: "fail", kind: "audit" },
        list: (repo, extra, pagination) =>
          repo.listByStatus({ status: "fail", ...extra } as ListByStatusOptions, pagination),
      },
      {
        name: "listTraceItems",
        index: "ByTrace",
        forward: true,
        partition: { tenantKey: "-", traceId: "trace-1" },
        list: (repo, extra, pagination) =>
          repo.listTraceItems({ trace: "trace-1", ...extra } as ListTraceItems, pagination),
      },
    ];

    /** A nextToken for the row's index keys, as DynamoDB would return it */
    const tokenFor = (listing: Listing, overrides: Record<string, unknown> = {}) => {
      const { partitionKeys, sortKeys } = Object.values(DynamoDB.Indexes).find(
        (index) => index.name === listing.index,
      )!;
      const row = indexRow(overrides) as Record<string, unknown>;
      return encodeNextPageToken(
        Object.fromEntries(
          ["PK", "SK", ...[...partitionKeys, ...sortKeys].map((key) => key.name)].map((name) => [
            name,
            row[name] as string | number,
          ]),
        ),
      );
    };

    describe.each(LISTINGS)("$name", (listing) => {
      it("should query its index partition", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });

        await listing.list(repository);

        const input = queryInput();
        expect(mockClient.send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
        expect(input).toMatchObject({
          TableName: TABLE,
          IndexName: listing.index,
          ScanIndexForward: listing.forward,
          Limit: 100,
        });
        expect(input.FilterExpression).toBeUndefined();
        expect(input.ExclusiveStartKey).toBeUndefined();
        expect(keyCondition(input)).toEqual(listing.partition);
      });

      it("should query a tenant's partition", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });

        await listing.list(repository, { tenantId: "tenant-a" });

        expect(keyCondition(queryInput())).toEqual({
          ...listing.partition,
          tenantKey: "tenant-a",
        });
      });

      it("should return summaries and a nextToken", async () => {
        const lastEvaluatedKey = { PK: "a", SK: "b" };
        mockClient.send.mockResolvedValue({
          Items: [marshall(indexRow(), { removeUndefinedValues: true })],
          LastEvaluatedKey: marshall(lastEvaluatedKey),
        });

        await expect(listing.list(repository)).resolves.toEqual({
          items: [
            {
              id: "audit-123",
              operation: "createOrder",
              status: "fail",
              tier: 1,
              target: { app: "App1", type: "Order", id: "order-1" },
              trace: "trace-1:2",
              updatedAt: CREATED_AT,
              createdAt: CREATED_AT,
            },
          ],
          pagination: { nextToken: encodeNextPageToken(lastEvaluatedKey) },
        });
      });

      it("should omit a trace stored as NULL", async () => {
        mockClient.send.mockResolvedValue({ Items: [marshall(indexRow({ trace: null }))] });

        const { items } = (await listing.list(repository)) as { items: object[] };

        expect(items[0]).not.toHaveProperty("trace");
      });

      it("should resume from a nextToken with the page size", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });
        const nextToken = tokenFor(listing);

        await listing.list(repository, {}, { pageSize: 5, nextToken });

        expect(queryInput()).toMatchObject({
          Limit: 5,
          ExclusiveStartKey: marshall(JSON.parse(Buffer.from(nextToken!, "base64url").toString())),
        });
      });

      it("should reject a nextToken holding another index's keys", async () => {
        const other = LISTINGS.find(({ index }) => index !== listing.index)!;

        await expect(
          listing.list(repository, {}, { nextToken: tokenFor(other) }),
        ).rejects.toBeInstanceOf(InvalidNextTokenError);
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it("should reject a nextToken from another partition", async () => {
        await expect(
          listing.list(repository, {}, { nextToken: tokenFor(listing, { tenantKey: "tenant-b" }) }),
        ).rejects.toBeInstanceOf(InvalidNextTokenError);
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it("should filter by operation and tier", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });

        await listing.list(repository, { operation: "createOrder", tier: 1 });

        const input = queryInput();
        expect(input.FilterExpression).toBe("#operation = :operation AND #tier = :tier");
        expect(input.ExpressionAttributeNames).toMatchObject({
          "#operation": "operation",
          "#tier": "tier",
        });
        expect(unmarshall(input.ExpressionAttributeValues ?? {})).toMatchObject({
          ":operation": "createOrder",
          ":tier": 1,
        });
      });
    });

    describe.each(LISTINGS.filter(({ index }) => index === "ByStatus" || index === "ByTrace"))(
      "$name resource filters",
      (listing) => {
        it.each<[string, Record<string, unknown>, string]>([
          ["an app", { app: App.App1 }, "App1"],
          ["a resource type", { resource: { type: ResourceType.USER } }, "*.User"],
          [
            "an app and type",
            { app: App.App1, resource: { type: ResourceType.USER } },
            "App1.User",
          ],
          [
            "a resource",
            { app: App.App1, resource: { type: ResourceType.USER, id: 7 } },
            "App1.User#7",
          ],
        ])("should match %s in the audit's scopes", async (_label, filters, scope) => {
          mockClient.send.mockResolvedValue({ Items: [] });

          await listing.list(repository, { ...filters, tier: 3 });

          const input = queryInput();
          expect(input.FilterExpression).toBe("#tier = :tier AND contains(#scopes, :scope)");
          expect(input.ExpressionAttributeNames?.["#scopes"]).toBe("scopes");
          expect(unmarshall(input.ExpressionAttributeValues ?? {})[":scope"]).toBe(scope);
        });

        it("should refuse a resource id without its app and type", async () => {
          await expect(
            listing.list(repository, { resource: { type: ResourceType.USER, id: 7 } }),
          ).rejects.toThrow(InvalidResourceFilterError);
          expect(mockClient.send).not.toHaveBeenCalled();
        });
      },
    );
  });
});

describe("resourceScopes", () => {
  it("should name a resource by its app, app and type, type, and id", () => {
    expect(resourceScopes({ app: "App1", type: "Order", id: "o" })).toEqual([
      "App1",
      "App1.Order",
      "*.Order",
      "App1.Order#o",
    ]);
  });

  it("should leave out the id scope without an id", () => {
    expect(resourceScopes({ app: "App1", type: "Order" })).toEqual([
      "App1",
      "App1.Order",
      "*.Order",
    ]);
  });
});

describe("filterScope", () => {
  it("should return undefined without filters", () => {
    expect(filterScope({})).toBeUndefined();
    expect(filterScope({ resource: {} })).toBeUndefined();
  });

  it("should treat a resource id of 0 as an id", () => {
    expect(filterScope({ app: "App1", resource: { type: "Order", id: 0 } })).toBe("App1.Order#0");
  });
});
