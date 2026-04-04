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
  type TypedIdentifiers,
  type TypedListItemsOptions,
  type TypedListTraceItems,
} from "./repository.js";
import { encodeNextPageToken } from "./repository.utils.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { App, ResourceType, testConfig } from "./test-config.js";

// Type aliases using test config for convenience
type Identifiers = TypedIdentifiers<typeof testConfig>;
type ListItemsOptions = TypedListItemsOptions<typeof testConfig>;
type ListTraceItems = TypedListTraceItems<typeof testConfig>;

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

    it("should resolve successfully when UnprocessedItems are returned on first call but empty on retry", async () => {
      vi.useFakeTimers();

      const tableName = DynamoDB.Table.Name();
      const items = [createMockUpsertInput()];

      // First call returns unprocessed items; second call returns empty
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

      // Always return unprocessed items
      mockClient.send.mockResolvedValue({ UnprocessedItems: unprocessedItems });

      // Attach the rejection assertion before running timers so the rejection is handled immediately
      const promise = repository.upsertBatch(items);
      const rejectAssertion = expect(promise).rejects.toThrow(
        "BatchWriteItem failed: unprocessed items after 8 retries",
      );
      // Advance timers repeatedly to drain all retry delays (8 retries, up to 30s each)
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

      // Return unprocessed twice, then resolve on 3rd call
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

    it("should add resource ID filter when provided", async () => {
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
      expect(command.input.FilterExpression).toContain("resourceId=:resourceId");
    });

    it("should add resource type filter when provided", async () => {
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
      expect(command.input.FilterExpression).toContain("resourceType=:resourceType");
    });

    it("should add app filter when provided", async () => {
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
      expect(command.input.FilterExpression).toContain("app=:app");
    });

    it("should filter out compound IDs", async () => {
      mockClient.send.mockResolvedValue({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const params: ListTraceItems = {
        trace: "trace-123",
      };

      await repository.listTraceItems(params);

      const command = mockClient.send.mock.calls[0][0] as QueryCommand;
      expect(command.input.FilterExpression).toContain("not contains(SK, :isParent)");
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
    });

    it("should combine multiple filters with AND", async () => {
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
      expect(command.input.FilterExpression).toContain(" AND ");
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
});
