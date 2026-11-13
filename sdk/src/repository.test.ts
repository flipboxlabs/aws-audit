import type { Logger } from "@aws-lambda-powertools/logger";
import {
  BatchWriteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DynamoDB } from "./constants.js";
import {
  AuditRepository,
  type TypedListByStatusOptions,
  type TypedIdentifiers,
  type TypedListItemsOptions,
  type TypedListObjectsOptions,
  type TypedListTraceItems,
} from "./repository.js";
import { encodeNextPageToken } from "./repository.utils.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { App, ResourceType, testConfig } from "./test-config.js";

// Type aliases using test config for convenience
type Identifiers = TypedIdentifiers<typeof testConfig>;
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

  const createMockAuditItem = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: "audit-123",
    operation: "testOperation",
    status: "success",
    tier: 2,
    target: {
      app: App.App1,
      type: ResourceType.UNKNOWN,
      id: "resource-123",
    },
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    PK: `${App.App1}.${ResourceType.UNKNOWN}`,
    SK: "audit-123",
    GSI1_SS_PK: `${App.App1}.${ResourceType.UNKNOWN}#resource-123`,
    GSI1_SS_SK: "audit-123",
    GSI1_SN_PK: "trace-123",
    GSI1_SN_SK: 1,
    LSI1_N_SK: 21234567890,
    ttl: Math.floor(Date.now() / 1000) + 7776000,
    ...overrides,
  });

  const createMockUpsertInput = (overrides: Partial<UpsertAuditInput> = {}): UpsertAuditInput =>
    ({
      operation: "testOperation",
      status: "success",
      tier: 2,
      target: {
        app: App.App1,
        type: ResourceType.UNKNOWN,
        id: "resource-123",
      },
      ...overrides,
    }) as UpsertAuditInput;

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
    it("should create an instance with provided dependencies", () => {
      expect(repository).toBeInstanceOf(AuditRepository);
    });

    it("should create default client when not provided", () => {
      const repoWithDefaults = new AuditRepository(mockLogger as unknown as Logger, testConfig);

      expect(repoWithDefaults).toBeInstanceOf(AuditRepository);
    });
  });

  describe("getItem", () => {
    it("should return undefined when item is not found", async () => {
      mockClient.send.mockResolvedValue({ Item: undefined });

      const result = await repository.getItem({
        id: "audit-123",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

      expect(result).toBeUndefined();
    });

    it("should return transformed audit when item exists", async () => {
      const mockItem = createMockAuditItem();
      mockClient.send.mockResolvedValue({
        Item: marshall(mockItem),
      });

      const result = await repository.getItem({
        id: "audit-123",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

      expect(result).toBeDefined();
      expect(result?.operation).toBe("testOperation");
    });

    it("should use correct primary key construction", async () => {
      mockClient.send.mockResolvedValue({ Item: undefined });

      const identifiers: Omit<Identifiers, "resourceId"> = {
        id: "audit-456",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      };

      await repository.getItem(identifiers);

      expect(mockClient.send).toHaveBeenCalledWith(expect.any(GetItemCommand));
      const command = mockClient.send.mock.calls[0][0] as GetItemCommand;
      expect(command.input.TableName).toBe(DynamoDB.Table.Name());
    });

    it("should log error and return undefined on exception", async () => {
      const error = new Error("DynamoDB error");
      mockClient.send.mockRejectedValue(error);

      const result = await repository.getItem({
        id: "audit-123",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Unable to find audit item in the repository",
        expect.objectContaining({
          identifiers: expect.any(Object),
          error,
        }),
      );
    });

    it("should handle item with compound ID", async () => {
      const mockItem = createMockAuditItem({
        id: "parent-id#child-id",
      });
      mockClient.send.mockResolvedValue({
        Item: marshall(mockItem),
      });

      const result = await repository.getItem({
        id: "parent-id#child-id",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

      expect(result).toBeDefined();
      expect(result?.id).toBe("child-id");
    });

    it("should construct tenant-prefixed partition key when tenantId is provided", async () => {
      mockClient.send.mockResolvedValue({ Item: undefined });

      await repository.getItem({
        tenantId: "tnt-123",
        id: "audit-456",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

      const command = mockClient.send.mock.calls[0][0] as GetItemCommand;
      const key = command.input.Key;
      expect(key?.PK?.S).toBe("tnt-123#App1.Unknown");
      expect(key?.SK?.S).toBe("audit-456");
    });

    it("should construct non-prefixed partition key when tenantId is not provided", async () => {
      mockClient.send.mockResolvedValue({ Item: undefined });

      await repository.getItem({
        id: "audit-456",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

      const command = mockClient.send.mock.calls[0][0] as GetItemCommand;
      const key = command.input.Key;
      expect(key?.PK?.S).toBe("App1.Unknown");
      expect(key?.SK?.S).toBe("audit-456");
    });
  });

  describe("upsertBatch", () => {
    it("should return true on successful batch write", async () => {
      mockClient.send.mockResolvedValue({});

      const items = [createMockUpsertInput()];

      const result = await repository.upsertBatch(items);

      expect(result).toBe(true);
      expect(mockClient.send).toHaveBeenCalledWith(expect.any(BatchWriteItemCommand));
    });

    it("should chunk items into batches of 25", async () => {
      mockClient.send.mockResolvedValue({});

      // Create 30 items
      const items = Array.from({ length: 30 }, (_, i) =>
        createMockUpsertInput({ operation: `op-${i}` }),
      );

      await repository.upsertBatch(items);

      // Should be called twice: 25 + 5
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it("should handle exactly 25 items as single batch", async () => {
      mockClient.send.mockResolvedValue({});

      const items = Array.from({ length: 25 }, (_, i) =>
        createMockUpsertInput({ operation: `op-${i}` }),
      );

      await repository.upsertBatch(items);

      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it("should handle empty items array", async () => {
      mockClient.send.mockResolvedValue({});

      const result = await repository.upsertBatch([]);

      expect(result).toBe(true);
      // No commands should be sent for empty array
    });

    it("should set timestamps on items", async () => {
      mockClient.send.mockResolvedValue({});

      const items = [createMockUpsertInput()];

      await repository.upsertBatch(items);

      const command = mockClient.send.mock.calls[0][0] as BatchWriteItemCommand;
      expect(command.input.RequestItems).toBeDefined();
    });

    it("should include TTL attribute", async () => {
      mockClient.send.mockResolvedValue({});

      const items = [createMockUpsertInput()];

      await repository.upsertBatch(items);

      expect(mockClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            RequestItems: expect.any(Object),
          }),
        }),
      );
    });

    it("should construct secondary keys including trace", async () => {
      mockClient.send.mockResolvedValue({});

      const items = [createMockUpsertInput({ trace: "trace-abc:2" })];

      await repository.upsertBatch(items);

      expect(mockClient.send).toHaveBeenCalled();
    });

    it("should handle items without trace", async () => {
      mockClient.send.mockResolvedValue({});

      const items = [createMockUpsertInput({ trace: undefined })];

      await repository.upsertBatch(items);

      expect(mockClient.send).toHaveBeenCalled();
    });

    it("should construct tenant-prefixed keys when tenantId is provided", async () => {
      mockClient.send.mockResolvedValue({});

      const items = [
        createMockUpsertInput({
          tenantId: "org-multi-tenant",
          trace: "trace-tenant:1",
        }),
      ];

      await repository.upsertBatch(items);

      const command = mockClient.send.mock.calls[0][0] as BatchWriteItemCommand;
      const item = command.input.RequestItems?.[DynamoDB.Table.Name()]?.[0]?.PutRequest?.Item;

      // Primary key should be tenant-prefixed
      expect(item?.PK?.S).toBe("org-multi-tenant#App1.Unknown");

      // GSI1_SS key should be tenant-prefixed
      expect(item?.GSI1_SS_PK?.S).toBe("org-multi-tenant#App1.Unknown#resource-123");

      // GSI1_SN key should be tenant-prefixed
      expect(item?.GSI1_SN_PK?.S).toBe("org-multi-tenant#trace-tenant");
    });

    it("should construct non-prefixed keys when tenantId is not provided", async () => {
      mockClient.send.mockResolvedValue({});

      const items = [createMockUpsertInput({ trace: "trace-no-tenant:1" })];

      await repository.upsertBatch(items);

      const command = mockClient.send.mock.calls[0][0] as BatchWriteItemCommand;
      const item = command.input.RequestItems?.[DynamoDB.Table.Name()]?.[0]?.PutRequest?.Item;

      // Primary key should NOT be prefixed
      expect(item?.PK?.S).toBe("App1.Unknown");

      // GSI1_SS key should NOT be prefixed
      expect(item?.GSI1_SS_PK?.S).toBe("App1.Unknown#resource-123");

      // GSI1_SN key should NOT be prefixed
      expect(item?.GSI1_SN_PK?.S).toBe("trace-no-tenant");
    });

    it("should use config ttlSeconds for TTL calculation", async () => {
      mockClient.send.mockResolvedValue({});

      const customTtlSeconds = 60 * 60 * 24 * 30; // 30 days
      const { defineAuditConfig } = await import("./config.js");
      const customConfig = defineAuditConfig({
        apps: ["App1", "TestApp"] as const,
        resourceTypes: ["Unknown", "User", "Order"] as const,
        ttlSeconds: customTtlSeconds,
      });
      const customRepo = new AuditRepository(
        mockLogger as unknown as Logger,
        customConfig,
        mockClient as unknown as DynamoDBClient,
      );

      const before = Math.floor(Date.now() / 1000);
      await customRepo.upsertBatch([createMockUpsertInput()]);
      const after = Math.floor(Date.now() / 1000);

      const command = mockClient.send.mock.calls[0][0] as BatchWriteItemCommand;
      const item = command.input.RequestItems?.[DynamoDB.Table.Name()]?.[0]?.PutRequest?.Item;
      const ttl = item?.ttl?.N ? Number(item.ttl.N) : 0;

      expect(ttl).toBeGreaterThanOrEqual(before + customTtlSeconds);
      expect(ttl).toBeLessThanOrEqual(after + customTtlSeconds);
    });

    it("should use default 90-day TTL when ttlSeconds is not configured", async () => {
      mockClient.send.mockResolvedValue({});

      const defaultTtlSeconds = 60 * 60 * 24 * 90;
      const before = Math.floor(Date.now() / 1000);
      await repository.upsertBatch([createMockUpsertInput()]);
      const after = Math.floor(Date.now() / 1000);

      const command = mockClient.send.mock.calls[0][0] as BatchWriteItemCommand;
      const item = command.input.RequestItems?.[DynamoDB.Table.Name()]?.[0]?.PutRequest?.Item;
      const ttl = item?.ttl?.N ? Number(item.ttl.N) : 0;

      expect(ttl).toBeGreaterThanOrEqual(before + defaultTtlSeconds);
      expect(ttl).toBeLessThanOrEqual(after + defaultTtlSeconds);
    });

    it("should resolve successfully when UnprocessedItems are returned on first call but empty on retry", async () => {
      vi.useFakeTimers();

      const tableName = DynamoDB.Table.Name();
      const items = [createMockUpsertInput()];

      mockClient.send
        .mockResolvedValueOnce({
          UnprocessedItems: {
            [tableName]: [
              {
                PutRequest: {
                  Item: marshall({ id: { S: "audit-123" } }),
                },
              },
            ],
          },
        })
        .mockResolvedValueOnce({ UnprocessedItems: {} });

      const promise = repository.upsertBatch(items);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe(true);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "BatchWriteItem: retrying unprocessed items",
        expect.objectContaining({ attempt: 1, count: expect.any(Number) }),
      );

      vi.useRealTimers();
    });

    it("should throw and log error when unprocessed items remain after max retries", async () => {
      vi.useFakeTimers();

      const tableName = DynamoDB.Table.Name();
      const items = [createMockUpsertInput()];
      const unprocessedItems = {
        [tableName]: [
          {
            PutRequest: {
              Item: marshall({ id: { S: "audit-123" } }),
            },
          },
        ],
      };

      mockClient.send.mockResolvedValue({ UnprocessedItems: unprocessedItems });

      const promise = repository.upsertBatch(items);
      const rejectAssertion = expect(promise).rejects.toThrow(
        "BatchWriteItem failed: unprocessed items after 8 retries",
      );
      for (let i = 0; i < 10; i++) {
        await vi.runAllTimersAsync();
      }
      await rejectAssertion;

      expect(mockLogger.error).toHaveBeenCalledWith(
        "BatchWriteItem: unprocessed items remain after max retries",
        expect.objectContaining({ attempt: expect.any(Number), unprocessed: expect.any(Object) }),
      );

      vi.useRealTimers();
    });

    it("should log a warning for each retry attempt", async () => {
      vi.useFakeTimers();

      const tableName = DynamoDB.Table.Name();
      const items = [createMockUpsertInput()];
      const unprocessedItems = {
        [tableName]: [
          {
            PutRequest: {
              Item: marshall({ id: { S: "audit-123" } }),
            },
          },
        ],
      };

      mockClient.send
        .mockResolvedValueOnce({ UnprocessedItems: unprocessedItems })
        .mockResolvedValueOnce({ UnprocessedItems: unprocessedItems })
        .mockResolvedValueOnce({ UnprocessedItems: {} });

      const promise = repository.upsertBatch(items);
      for (let i = 0; i < 5; i++) {
        await vi.runAllTimersAsync();
      }
      await promise;

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe("listObjects", () => {
    const params: ListObjectsOptions = {
      app: App.App1,
      resource: {
        type: ResourceType.UNKNOWN,
      },
    };

    it("should query the LSI using the app and resource type partition key", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      await repository.listObjects(params);

      expect(mockClient.send).toHaveBeenCalledWith(expect.any(QueryCommand));
      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.IndexName).toBe(DynamoDB.Indexes.LSI1_N);
      expect(command.input.KeyConditionExpression).toBe("#PK=:PK");
      expect(command.input.ExpressionAttributeValues?.[":PK"]?.S).toBe("App1.Unknown");
      expect(command.input.ScanIndexForward).toBe(false);
      expect(command.input.Limit).toBe(100);
    });

    it("should use pagination parameters", async () => {
      const token = encodeNextPageToken({
        PK: "App1.Unknown",
        SK: "audit-123",
        LSI1_N_SK: 21234567890,
      });

      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      await repository.listObjects(params, {
        pageSize: 25,
        nextToken: token,
      });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.Limit).toBe(25);
      expect(command.input.ExclusiveStartKey).toBeDefined();
    });

    it("should prefix the partition key with the tenant ID", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      await repository.listObjects({
        ...params,
        tenantId: "org-456",
      });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.ExpressionAttributeValues?.[":PK"]?.S).toBe("org-456#App1.Unknown");
    });

    it("should transform items without creating a bogus trace", async () => {
      const mockListItem = createMockAuditItem({
        SK: "audit-123#App1.Unknown#resource-123",
        GSI1_SN_PK: undefined,
        GSI1_SN_SK: undefined,
      });

      mockClient.send.mockResolvedValue({
        Items: [
          marshall(mockListItem, {
            removeUndefinedValues: true,
          }),
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await repository.listObjects(params);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("audit-123");
      expect(result.items[0].trace).toBeUndefined();
    });

    it("should return a next token when DynamoDB has another page", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: {
          PK: { S: "App1.Unknown" },
          SK: { S: "audit-last" },
          LSI1_N_SK: { N: "21234567890" },
        },
      });

      const result = await repository.listObjects(params);

      expect(result.pagination?.nextToken).toBeDefined();
    });
  });

  describe("listItems", () => {
    it("should query GSI1_SS index", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      await repository.listItems(params);

      expect(mockClient.send).toHaveBeenCalledWith(expect.any(QueryCommand));
      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.IndexName).toBe(DynamoDB.Indexes.GSI1_SS);
    });

    it("should use default page size of 100", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      await repository.listItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.Limit).toBe(100);
    });

    it("should use provided page size", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      await repository.listItems(params, { pageSize: 50 });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.Limit).toBe(50);
    });

    it("should decode next token for pagination", async () => {
      const startKey = { PK: "App1.Unknown", SK: "audit-123" };
      const token = encodeNextPageToken(startKey);

      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      await repository.listItems(params, { nextToken: token });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.ExclusiveStartKey).toBeDefined();
    });

    it("should return paginated collection with items", async () => {
      const mockListItem = {
        operation: "testOp",
        status: "success",
        target: {
          app: App.App1,
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        attempts: [{ number: 1, status: "success", at: "2024-01-02T00:00:00.000Z" }],
        error: { message: "List item error" },
        PK: `${App.App1}.${ResourceType.UNKNOWN}`,
        SK: "audit-123",
        GSI1_SS_PK: `${App.App1}.${ResourceType.UNKNOWN}#resource-123`,
        GSI1_SS_SK: "audit-123",
        GSI1_SN_PK: "trace-123",
        GSI1_SN_SK: 1,
      };

      mockClient.send.mockResolvedValue({
        Items: [marshall(mockListItem)],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      const result = await repository.listItems(params);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].operation).toBe("testOp");
      expect(result.items[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
      expect(result.items[0].updatedAt).toBe("2024-01-02T00:00:00.000Z");
      expect(result.items[0].attempts).toEqual([
        { number: 1, status: "success", at: "2024-01-02T00:00:00.000Z" },
      ]);
      expect(result.items[0].error).toEqual({ message: "List item error" });
    });

    it("should include nextToken when LastEvaluatedKey exists", async () => {
      const lastKey = { PK: { S: "App1.Unknown" }, SK: { S: "audit-last" } };

      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: lastKey,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      const result = await repository.listItems(params);

      expect(result.pagination?.nextToken).toBeDefined();
    });

    it("should scan in reverse order", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      await repository.listItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.ScanIndexForward).toBe(false);
    });

    it("should construct tenant-prefixed partition key when tenantId is provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        tenantId: "org-456",
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      await repository.listItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      const expressionValues = command.input.ExpressionAttributeValues;
      expect(expressionValues?.[":PK"]?.S).toBe("org-456#App1.Unknown#resource-123");
    });

    it("should construct non-prefixed partition key when tenantId is not provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListItemsOptions = {
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
      };

      await repository.listItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      const expressionValues = command.input.ExpressionAttributeValues;
      expect(expressionValues?.[":PK"]?.S).toBe("App1.Unknown#resource-123");
    });
  });

  describe("upsertItem", () => {
    it("should send UpdateItemCommand with correct table name", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      expect(mockClient.send).toHaveBeenCalledWith(expect.any(UpdateItemCommand));
      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.TableName).toBe(DynamoDB.Table.Name());
    });

    it("should return attempt number from response", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [
            { number: 1, status: "fail", at: "2024-01-01T00:00:00Z" },
            { number: 2, status: "success", at: "2024-01-02T00:00:00Z" },
          ],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-02T00:00:00Z",
      };

      const result = await repository.upsertItem(item, attempt);

      expect(result).toBe(2);
    });

    it("should update the appended attempt number for retries", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [
            { number: 1, status: "fail", at: "2024-01-01T00:00:00Z" },
            { number: 1, status: "success", at: "2024-01-02T00:00:00Z" },
          ],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-02T00:00:00Z",
      };

      const result = await repository.upsertItem(item, attempt);

      expect(result).toBe(2);
      expect(mockClient.send).toHaveBeenCalledTimes(2);

      const command = mockClient.send.mock.calls[1][0] as UpdateItemCommand;
      expect(command.input.UpdateExpression).toBe("SET #attempts[1].#number = :attemptNumber");
      expect(command.input.ExpressionAttributeNames).toEqual({
        "#attempts": "attempts",
        "#number": "number",
      });
      expect(command.input.ExpressionAttributeValues?.[":attemptNumber"]?.N).toBe("2");
    });

    it("should include list_append expression for attempts", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.UpdateExpression).toContain(
        "#attempts = list_append(if_not_exists(#attempts, :emptyList), :newAttempt)",
      );
    });

    it("should include if_not_exists expression for createdAt", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.UpdateExpression).toContain(
        "#createdAt = if_not_exists(#createdAt, :createdAt)",
      );
    });

    it("should request ALL_NEW return values", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.ReturnValues).toBe("ALL_NEW");
    });

    it("should throw error when Attributes is undefined", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: undefined,
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await expect(repository.upsertItem(item, attempt)).rejects.toThrow(
        "UpdateItem did not return attributes",
      );
    });

    it("should include all payload fields in update expression", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput({
        message: "Test message",
        trace: "trace-123:1",
      });
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.UpdateExpression).toContain("#status");
      expect(command.input.UpdateExpression).toContain("#operation");
      expect(command.input.UpdateExpression).toContain("#target");
      expect(command.input.UpdateExpression).toContain("#message");
      expect(command.input.UpdateExpression).toContain("#trace");
    });

    it("should include TTL in update expression", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.UpdateExpression).toContain("#ttl");
      expect(command.input.ExpressionAttributeNames).toHaveProperty("#ttl", "ttl");
    });

    it("should construct correct primary key", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.Key?.PK?.S).toBe("App1.Unknown");
    });

    it("should construct tenant-prefixed primary key when tenantId is provided", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput({ tenantId: "tenant-abc" });
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.Key?.PK?.S).toBe("tenant-abc#App1.Unknown");
    });

    it("should include secondary keys in update expression", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput({ trace: "trace-xyz:3" });
      const attempt = {
        number: 1,
        status: "success",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      // Should include GSI keys
      expect(command.input.ExpressionAttributeNames).toHaveProperty("#GSI1_SS_PK", "GSI1_SS_PK");
      expect(command.input.ExpressionAttributeNames).toHaveProperty("#GSI1_SN_PK", "GSI1_SN_PK");
    });

    it("should include attempt with error in expression values", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [
            {
              number: 1,
              status: "fail",
              error: "Connection timeout",
              at: "2024-01-01T00:00:00Z",
            },
          ],
        }),
      });

      const item = createMockUpsertInput({ status: "fail" });
      const attempt = {
        number: 1,
        status: "fail",
        error: "Connection timeout",
        at: "2024-01-01T00:00:00Z",
      };

      await repository.upsertItem(item, attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.ExpressionAttributeValues?.[":newAttempt"]).toBeDefined();
    });

    it("should use config ttlSeconds for TTL in upsertItem", async () => {
      const customTtlSeconds = 60 * 60 * 24 * 7; // 7 days
      const { defineAuditConfig } = await import("./config.js");
      const customConfig = defineAuditConfig({
        apps: ["App1", "TestApp"] as const,
        resourceTypes: ["Unknown", "User", "Order"] as const,
        ttlSeconds: customTtlSeconds,
      });
      const customRepo = new AuditRepository(
        mockLogger as unknown as Logger,
        customConfig,
        mockClient as unknown as DynamoDBClient,
      );

      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput();
      const attempt = { number: 1, status: "success", at: "2024-01-01T00:00:00Z" };

      const before = Math.floor(Date.now() / 1000);
      await customRepo.upsertItem(item, attempt);
      const after = Math.floor(Date.now() / 1000);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      const ttlValue = command.input.ExpressionAttributeValues?.[":ttl"]?.N;
      const ttl = ttlValue ? Number(ttlValue) : 0;

      expect(ttl).toBeGreaterThanOrEqual(before + customTtlSeconds);
      expect(ttl).toBeLessThanOrEqual(after + customTtlSeconds);
    });

    it("should ignore caller-supplied attempts", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
        }),
      });

      const item = createMockUpsertInput({
        attempts: [
          { number: 1, status: "fail", at: "2023-12-31T00:00:00Z" },
          { number: 2, status: "fail", at: "2023-12-31T01:00:00Z" },
        ],
      });
      const attempt = { number: 1, status: "success", at: "2024-01-01T00:00:00Z" };

      await expect(repository.upsertItem(item, attempt)).resolves.toBe(1);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.ExpressionAttributeValues).not.toHaveProperty(":attempts");
      expect(command.input.ExpressionAttributeValues?.[":newAttempt"]?.L).toHaveLength(1);
      expect(command.input.UpdateExpression).not.toContain("#attempts = :attempts");
    });

    it("should renumber a retry on an existing item and ignore caller-supplied attempts", async () => {
      mockClient.send.mockResolvedValue({
        Attributes: marshall({
          attempts: [
            { number: 1, status: "fail", at: "2024-01-01T00:00:00Z" },
            { number: 2, status: "fail", at: "2024-01-02T00:00:00Z" },
            { number: 1, status: "success", at: "2024-01-03T00:00:00Z" },
          ],
        }),
      });

      const item = createMockUpsertInput({
        attempts: [{ number: 9, status: "fail", at: "2023-12-31T00:00:00Z" }],
      });
      const attempt = { number: 1, status: "success", at: "2024-01-03T00:00:00Z" };

      await expect(repository.upsertItem(item, attempt)).resolves.toBe(3);
      expect(mockClient.send).toHaveBeenCalledTimes(2);

      const [update, renumber] = mockClient.send.mock.calls.map(
        ([command]) => (command as UpdateItemCommand).input,
      );
      expect(update.ExpressionAttributeValues).not.toHaveProperty(":attempts");
      expect(update.ExpressionAttributeValues?.[":newAttempt"]).toEqual(
        marshall({ v: [attempt] }).v,
      );

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
        },
      ],
      ["tenant", { tenantId: "tenant-abc" }],
    ])(
      "should only send expression names and values the update expression uses (%s)",
      async (_label, overrides) => {
        mockClient.send.mockResolvedValue({
          Attributes: marshall({
            attempts: [{ number: 1, status: "success", at: "2024-01-01T00:00:00Z" }],
          }),
        });

        const attempt = { number: 1, status: "success", at: "2024-01-01T00:00:00Z" };
        await repository.upsertItem(createMockUpsertInput(overrides), attempt);

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

  describe("listTraceItems", () => {
    it("should query GSI1_SN index", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      await repository.listTraceItems(params);

      expect(mockClient.send).toHaveBeenCalledWith(expect.any(QueryCommand));
      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.IndexName).toBe(DynamoDB.Indexes.GSI1_SN);
    });

    it("should use trace as partition key", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-abc-123",
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.KeyConditionExpression).toBe("#PK=:PK");
    });

    it("should filter on target.id when resource ID is provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
        resource: {
          id: "resource-456",
        },
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toBe(
        "#target.#id = :resourceId AND not contains(SK, :isParent)",
      );
      expect(command.input.ExpressionAttributeNames).toEqual({
        "#PK": DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
        "#target": "target",
        "#id": "id",
      });
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":PK": { S: "trace-123" },
        ":resourceId": { S: "resource-456" },
        ":isParent": { S: "#" },
      });
    });

    it("should filter on target.type when resource type is provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
        resource: {
          type: ResourceType.UNKNOWN,
        },
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toBe(
        "#target.#type = :resourceType AND not contains(SK, :isParent)",
      );
      expect(command.input.ExpressionAttributeNames).toEqual({
        "#PK": DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
        "#target": "target",
        "#type": "type",
      });
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":PK": { S: "trace-123" },
        ":resourceType": { S: ResourceType.UNKNOWN },
        ":isParent": { S: "#" },
      });
    });

    it("should filter on target.app when app is provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
        app: App.App1,
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toBe(
        "#target.#app = :app AND not contains(SK, :isParent)",
      );
      expect(command.input.ExpressionAttributeNames).toEqual({
        "#PK": DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
        "#target": "target",
        "#app": "app",
      });
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":PK": { S: "trace-123" },
        ":app": { S: App.App1 },
        ":isParent": { S: "#" },
      });
    });

    it("should only filter out compound IDs when no filters are provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toBe("not contains(SK, :isParent)");
      expect(command.input.ExpressionAttributeNames).toEqual({
        "#PK": DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
      });
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":PK": { S: "trace-123" },
        ":isParent": { S: "#" },
      });
    });

    it("should scan in forward order for trace items", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.ScanIndexForward).toBe(true);
    });

    it("should handle pagination with nextToken", async () => {
      const startKey = { GSI1_SN_PK: "trace-123", GSI1_SN_SK: "1" };
      const token = encodeNextPageToken(startKey);

      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      await repository.listTraceItems(params, { nextToken: token });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.ExclusiveStartKey).toBeDefined();
    });

    it("should return transformed trace items", async () => {
      const mockTraceItem = {
        operation: "traceOp",
        status: "success",
        target: {
          app: App.App1,
          type: ResourceType.UNKNOWN,
          id: "resource-123",
        },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        attempts: [{ number: 1, status: "success", at: "2024-01-02T00:00:00.000Z" }],
        error: { message: "Trace item error" },
        PK: `${App.App1}.${ResourceType.UNKNOWN}`,
        SK: "audit-123",
        GSI1_SN_PK: "trace-123",
        GSI1_SN_SK: 1,
      };

      mockClient.send.mockResolvedValue({
        Items: [marshall(mockTraceItem)],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      const result = await repository.listTraceItems(params);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].operation).toBe("traceOp");
      expect(result.items[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
      expect(result.items[0].updatedAt).toBe("2024-01-02T00:00:00.000Z");
      expect(result.items[0].attempts).toEqual([
        { number: 1, status: "success", at: "2024-01-02T00:00:00.000Z" },
      ]);
      expect(result.items[0].error).toEqual({ message: "Trace item error" });
    });

    it("should combine target filters with AND", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-456",
        },
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toBe(
        "#target.#id = :resourceId AND #target.#type = :resourceType AND #target.#app = :app AND not contains(SK, :isParent)",
      );
      expect(command.input.ExpressionAttributeNames).toEqual({
        "#PK": DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
        "#target": "target",
        "#id": "id",
        "#type": "type",
        "#app": "app",
      });
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":PK": { S: "trace-123" },
        ":resourceId": { S: "resource-456" },
        ":resourceType": { S: ResourceType.UNKNOWN },
        ":app": { S: App.App1 },
        ":isParent": { S: "#" },
      });
    });

    it("should use provided page size", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      await repository.listTraceItems(params, { pageSize: 25 });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.Limit).toBe(25);
    });

    it("should return nextToken when LastEvaluatedKey is present", async () => {
      const lastKey = {
        PK: `${App.App1}.${ResourceType.UNKNOWN}`,
        SK: "audit-456",
        GSI1_SN_PK: "trace-123",
        GSI1_SN_SK: 2,
      };

      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: marshall(lastKey),
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      const result = await repository.listTraceItems(params);

      expect(result.pagination?.nextToken).toBeDefined();
      expect(typeof result.pagination?.nextToken).toBe("string");
    });

    it("should construct tenant-prefixed partition key when tenantId is provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        tenantId: "org-789",
        trace: "trace-abc-123",
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      const expressionValues = command.input.ExpressionAttributeValues;
      expect(expressionValues?.[":PK"]?.S).toBe("org-789#trace-abc-123");
    });

    it("should construct non-prefixed partition key when tenantId is not provided", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-abc-123",
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      const expressionValues = command.input.ExpressionAttributeValues;
      expect(expressionValues?.[":PK"]?.S).toBe("trace-abc-123");
    });
  });

  describe("listByStatus", () => {
    it("should query the status index with the provided status", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListByStatusOptions = {
        status: "fail",
      };

      await repository.listByStatus(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.IndexName).toBe(DynamoDB.Indexes.GSI2_SS);
      expect(command.input.KeyConditionExpression).toBe("#PK = :PK");
      expect(command.input.ScanIndexForward).toBe(false);
      expect(command.input.ExpressionAttributeValues?.[":PK"]?.S).toBe("fail");
      expect(command.input.FilterExpression).toContain("not contains(SK, :isParent)");
    });

    it("should include app and resource filters", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListByStatusOptions = {
        status: "warn",
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-456",
        },
      };

      await repository.listByStatus(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toContain("#target.#app = :app");
      expect(command.input.FilterExpression).toContain("#target.#type = :resourceType");
      expect(command.input.FilterExpression).toContain("#target.#id = :resourceId");
      expect(command.input.FilterExpression).toContain(" AND ");
      expect(command.input.ExpressionAttributeValues?.[":app"]?.S).toBe(App.App1);
      expect(command.input.ExpressionAttributeValues?.[":resourceType"]?.S).toBe(
        ResourceType.UNKNOWN,
      );
      expect(command.input.ExpressionAttributeValues?.[":resourceId"]?.S).toBe("resource-456");
    });

    it("should send the exact combined target filter", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      await repository.listByStatus({
        status: "warn",
        app: App.App1,
        resource: {
          type: ResourceType.UNKNOWN,
          id: "resource-456",
        },
      });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toBe(
        "#target.#id = :resourceId AND #target.#type = :resourceType AND #target.#app = :app AND not contains(SK, :isParent)",
      );
      expect(command.input.ExpressionAttributeNames).toEqual({
        "#PK": DynamoDB.Keys.GSI2_SS_PARTITION_KEY,
        "#target": "target",
        "#id": "id",
        "#type": "type",
        "#app": "app",
      });
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":PK": { S: "warn" },
        ":resourceId": { S: "resource-456" },
        ":resourceType": { S: ResourceType.UNKNOWN },
        ":app": { S: App.App1 },
        ":isParent": { S: "#" },
      });
    });

    it("should use tenant-prefixed partition key and pagination", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: marshall({
          PK: `${App.App1}.${ResourceType.UNKNOWN}`,
          SK: "audit-456",
          GSI2_SS_PK: "tenant-123#fail",
          GSI2_SS_SK: "2024-01-01T00:00:00.000Z#audit-456",
        }),
      });

      const params: ListByStatusOptions = {
        tenantId: "tenant-123",
        status: "fail",
      };

      const nextToken = encodeNextPageToken({
        PK: `${App.App1}.${ResourceType.UNKNOWN}`,
        SK: "audit-123",
        GSI2_SS_PK: "tenant-123#fail",
        GSI2_SS_SK: "2024-01-02T00:00:00.000Z#audit-123",
      });

      const result = await repository.listByStatus(params, { pageSize: 25, nextToken });

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.ExpressionAttributeValues?.[":PK"]?.S).toBe("tenant-123#fail");
      expect(command.input.Limit).toBe(25);
      expect(command.input.ExclusiveStartKey).toBeDefined();
      expect(result.pagination?.nextToken).toBeDefined();
    });

    it("should return the projected status item fields", async () => {
      mockClient.send.mockResolvedValue({
        Items: [
          marshall({
            PK: `${App.App1}.${ResourceType.UNKNOWN}`,
            SK: "audit-123",
            GSI2_SS_PK: "fail",
            GSI2_SS_SK: "2024-01-02T00:00:00.000Z#audit-123",
            operation: "statusOp",
            status: "fail",
            target: {
              app: App.App1,
              type: ResourceType.UNKNOWN,
              id: "resource-123",
            },
            createdAt: "2024-01-02T00:00:00.000Z",
            updatedAt: "2024-01-03T00:00:00.000Z",
            attempts: [{ number: 1, status: "fail", at: "2024-01-03T00:00:00.000Z" }],
            error: { message: "Status item error" },
          }),
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await repository.listByStatus({ status: "fail" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].createdAt).toBe("2024-01-02T00:00:00.000Z");
      expect(result.items[0].updatedAt).toBe("2024-01-03T00:00:00.000Z");
      expect(result.items[0].attempts).toEqual([
        { number: 1, status: "fail", at: "2024-01-03T00:00:00.000Z" },
      ]);
      expect(result.items[0].error).toEqual({ message: "Status item error" });
    });

    it("should not synthesize trace when the status query item does not include trace keys", async () => {
      mockClient.send.mockResolvedValue({
        Items: [
          marshall({
            PK: `${App.App1}.${ResourceType.UNKNOWN}`,
            SK: "audit-123",
            GSI2_SS_PK: "fail",
            GSI2_SS_SK: "2024-01-02T00:00:00.000Z#audit-123",
            operation: "statusOp",
            status: "fail",
            target: {
              app: App.App1,
              type: ResourceType.UNKNOWN,
              id: "resource-123",
            },
            createdAt: "2024-01-02T00:00:00.000Z",
          }),
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await repository.listByStatus({ status: "fail" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].trace).toBeUndefined();
    });
  });

  describe("trace resolution", () => {
    const getItem = () =>
      repository.getItem({
        id: "audit-123",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

    const mockQueryItems = (...items: Record<string, unknown>[]) =>
      mockClient.send.mockResolvedValue({
        Items: items.map((item) => marshall(item, { removeUndefinedValues: true })),
        LastEvaluatedKey: undefined,
      });

    // The attributes GSI1_SS and GSI1_SN project: no `trace` or `tenantId`
    const createProjectedItem = (overrides: Record<string, unknown> = {}) => ({
      PK: `${App.App1}.${ResourceType.UNKNOWN}`,
      SK: "audit-123",
      operation: "testOperation",
      status: "success",
      target: {
        app: App.App1,
        type: ResourceType.UNKNOWN,
        id: "resource-123",
      },
      createdAt: "2024-01-01T00:00:00.000Z",
      ...overrides,
    });

    const listItems = (tenantId?: string) =>
      repository.listItems({
        tenantId,
        app: App.App1,
        resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
      });

    const listTraceItems = (tenantId?: string) =>
      repository.listTraceItems({ tenantId, trace: "abc" });

    describe("getItem", () => {
      it("should return the stored trace verbatim", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(
            createMockAuditItem({
              tenantId: "t1",
              trace: "abc:1",
              GSI1_SN_PK: "t1#abc",
              GSI1_SN_SK: 1,
            }),
          ),
        });

        expect((await getItem())?.trace).toBe("abc:1");
      });

      it("should return a stored stage-0 trace as written, not rebuilt from the keys", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(createMockAuditItem({ trace: "abc:0", GSI1_SN_PK: "abc", GSI1_SN_SK: 0 })),
        });

        expect((await getItem())?.trace).toBe("abc:0");
      });

      it("should omit trace when it's stored as NULL", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(
            createMockAuditItem({ trace: null, GSI1_SN_PK: undefined, GSI1_SN_SK: undefined }),
            { removeUndefinedValues: true },
          ),
        });

        const result = await getItem();

        expect(result).toBeDefined();
        expect(result).not.toHaveProperty("trace");
      });

      it("should return a stage-less stored trace without a stage", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(createMockAuditItem({ trace: "abc", GSI1_SN_PK: "abc", GSI1_SN_SK: 0 })),
        });

        expect((await getItem())?.trace).toBe("abc");
      });

      it("should omit trace when the audit has none", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(createMockAuditItem({ GSI1_SN_PK: undefined, GSI1_SN_SK: undefined }), {
            removeUndefinedValues: true,
          }),
        });

        const result = await getItem();

        expect(result).toBeDefined();
        expect(result).not.toHaveProperty("trace");
      });

      it("should rebuild the trace from the keys without a stage when the stage is 0", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(createMockAuditItem({ GSI1_SN_PK: "abc", GSI1_SN_SK: 0 })),
        });

        expect((await getItem())?.trace).toBe("abc");
      });

      it("should rebuild the trace from the keys with a non-zero stage", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(createMockAuditItem({ GSI1_SN_PK: "abc", GSI1_SN_SK: 2 })),
        });

        expect((await getItem())?.trace).toBe("abc:2");
      });

      it("should strip the item's tenant prefix when rebuilding the trace", async () => {
        mockClient.send.mockResolvedValue({
          Item: marshall(
            createMockAuditItem({ tenantId: "t1", GSI1_SN_PK: "t1#abc", GSI1_SN_SK: 1 }),
          ),
        });

        expect((await getItem())?.trace).toBe("abc:1");
      });
    });

    describe("listObjects", () => {
      const listObjects = (tenantId?: string) =>
        repository.listObjects({
          tenantId,
          app: App.App1,
          resource: { type: ResourceType.UNKNOWN },
        });

      it("should return the stored trace verbatim", async () => {
        mockQueryItems(
          createMockAuditItem({
            tenantId: "t1",
            trace: "abc",
            GSI1_SN_PK: "t1#abc",
            GSI1_SN_SK: 0,
          }),
        );

        const result = await listObjects("t1");

        expect(result.items[0].trace).toBe("abc");
      });

      it("should return a stored stage-0 trace as written, not rebuilt from the keys", async () => {
        mockQueryItems(createMockAuditItem({ trace: "abc:0", GSI1_SN_PK: "abc", GSI1_SN_SK: 0 }));

        const result = await listObjects();

        expect(result.items[0].trace).toBe("abc:0");
      });

      it("should omit trace when it's stored as NULL", async () => {
        mockQueryItems(
          createMockAuditItem({ trace: null, GSI1_SN_PK: undefined, GSI1_SN_SK: undefined }),
        );

        const result = await listObjects();

        expect(result.items[0]).not.toHaveProperty("trace");
      });

      it("should omit trace when the audit has none", async () => {
        mockQueryItems(createMockAuditItem({ GSI1_SN_PK: undefined, GSI1_SN_SK: undefined }));

        const result = await listObjects();

        expect(result.items[0]).not.toHaveProperty("trace");
      });
    });

    describe("listItems", () => {
      it("should rebuild the trace without a stage when the stage is 0", async () => {
        mockQueryItems(createProjectedItem({ GSI1_SN_PK: "abc", GSI1_SN_SK: 0 }));

        const result = await listItems();

        expect(result.items[0].trace).toBe("abc");
      });

      it("should rebuild the trace with a non-zero stage", async () => {
        mockQueryItems(createProjectedItem({ GSI1_SN_PK: "abc", GSI1_SN_SK: 2 }));

        const result = await listItems();

        expect(result.items[0].trace).toBe("abc:2");
      });

      it("should strip the queried tenant's prefix", async () => {
        mockQueryItems(createProjectedItem({ GSI1_SN_PK: "t1#abc", GSI1_SN_SK: 1 }));

        const result = await listItems("t1");

        expect(result.items[0].trace).toBe("abc:1");
      });

      it("should not guess a tenant prefix when the tenant isn't known", async () => {
        mockQueryItems(createProjectedItem({ GSI1_SN_PK: "t1#abc", GSI1_SN_SK: 1 }));

        const result = await listItems();

        expect(result.items[0].trace).toBe("t1#abc:1");
      });

      it("should omit trace when the audit has none", async () => {
        mockQueryItems(createProjectedItem());

        const result = await listItems();

        expect(result.items[0]).not.toHaveProperty("trace");
      });
    });

    describe("listTraceItems", () => {
      it("should rebuild the trace without a stage when the stage is 0", async () => {
        mockQueryItems(createProjectedItem({ GSI1_SN_PK: "abc", GSI1_SN_SK: 0 }));

        const result = await listTraceItems();

        expect(result.items[0].trace).toBe("abc");
      });

      it("should rebuild the trace with a non-zero stage", async () => {
        mockQueryItems(createProjectedItem({ GSI1_SN_PK: "abc", GSI1_SN_SK: 2 }));

        const result = await listTraceItems();

        expect(result.items[0].trace).toBe("abc:2");
      });

      it("should strip the queried tenant's prefix", async () => {
        mockQueryItems(createProjectedItem({ GSI1_SN_PK: "t1#abc", GSI1_SN_SK: 0 }));

        const result = await listTraceItems("t1");

        expect(result.items[0].trace).toBe("abc");
      });
    });

    describe("listByStatus", () => {
      it("should omit trace, which the status index doesn't project", async () => {
        mockQueryItems(
          createProjectedItem({
            GSI2_SS_PK: "t1#success",
            GSI2_SS_SK: "2024-01-01T00:00:00.000Z#audit-123",
          }),
        );

        const result = await repository.listByStatus({ tenantId: "t1", status: "success" });

        expect(result.items[0]).not.toHaveProperty("trace");
      });
    });
  });
});
