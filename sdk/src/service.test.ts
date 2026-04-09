import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Audit } from "./schema/audit.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { AuditService } from "./service.js";
import { App, ResourceType, testConfig } from "./test-config.js";

// Mock the repository
vi.mock("./repository.js", () => ({
  AuditRepository: vi.fn().mockImplementation(() => ({
    getItem: vi.fn(),
    upsertBatch: vi.fn(),
    listItems: vi.fn(),
    listTraceItems: vi.fn(),
  })),
}));

// Mock the eventbridge
vi.mock("./eventbridge.js", () => ({
  AuditEventBus: vi.fn().mockImplementation(() => ({
    upserted: vi.fn(),
  })),
}));

describe("AuditService", () => {
  let service: AuditService<typeof testConfig>;
  let mockLogger: {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let mockStorage: {
    getItem: ReturnType<typeof vi.fn>;
    upsertItem: ReturnType<typeof vi.fn>;
    upsertBatch: ReturnType<typeof vi.fn>;
    listItems: ReturnType<typeof vi.fn>;
    listTraceItems: ReturnType<typeof vi.fn>;
  };
  let mockEvents: {
    upserted: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockStorage = {
      getItem: vi.fn(),
      upsertItem: vi.fn().mockResolvedValue(1), // Returns attempt number
      upsertBatch: vi.fn(),
      listItems: vi.fn(),
      listTraceItems: vi.fn(),
    };

    mockEvents = {
      upserted: vi.fn(),
    };

    service = new AuditService(
      mockLogger as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[0],
      testConfig,
      mockStorage as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[2],
      mockEvents as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[3],
    );
  });

  describe("constructor", () => {
    it("should create an instance with provided dependencies", () => {
      expect(service).toBeInstanceOf(AuditService);
      expect(service.events).toBe(mockEvents);
    });

    it("should allow null events", () => {
      const serviceWithoutEvents = new AuditService(
        mockLogger as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[0],
        testConfig,
        mockStorage as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[2],
        null,
      );

      expect(serviceWithoutEvents.events).toBeNull();
    });

    it("should allow undefined events when explicitly passed", () => {
      const serviceWithUndefined = new AuditService(
        mockLogger as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[0],
        testConfig,
        mockStorage as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[2],
        undefined,
      );

      // When explicitly passing undefined, the default value still kicks in
      // This tests that the code handles the default correctly
      expect(serviceWithUndefined.events).toBeDefined();
    });
  });

  describe("getItem", () => {
    const mockAudit: Audit = {
      id: "audit-123",
      operation: "testOperation",
      status: "success",
      tier: 2,
      target: {
        app: App.App1,
        type: ResourceType.UNKNOWN,
        id: "resource-123",
      },
      updatedAt: new Date("2024-01-15T10:30:00.000Z"),
      createdAt: new Date("2024-01-15T10:30:00.000Z"),
    };

    it("should return an audit when found", async () => {
      mockStorage.getItem.mockResolvedValue(mockAudit);

      const result = await service.getItem({
        id: "audit-123",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });

      expect(result).toEqual(mockAudit);
      expect(mockStorage.getItem).toHaveBeenCalledWith({
        id: "audit-123",
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
      });
    });

    it("should throw an error when audit is not found", async () => {
      mockStorage.getItem.mockResolvedValue(null);

      await expect(
        service.getItem({
          id: "missing-audit",
          app: App.App1,
          resourceType: ResourceType.UNKNOWN,
        }),
      ).rejects.toThrow("Unable to find Audit");
    });

    it("should include identifiers in error message", async () => {
      mockStorage.getItem.mockResolvedValue(null);

      await expect(
        service.getItem({
          id: "test-id",
          app: App.App1,
          resourceType: ResourceType.UNKNOWN,
        }),
      ).rejects.toThrow(/id:test-id/);
    });

    it("should throw when storage returns undefined", async () => {
      mockStorage.getItem.mockResolvedValue(undefined);

      await expect(
        service.getItem({
          id: "audit-123",
          app: App.App1,
          resourceType: ResourceType.UNKNOWN,
        }),
      ).rejects.toThrow("Unable to find Audit");
    });
  });

  describe("upsertItem", () => {
    const baseInput: UpsertAuditInput = {
      operation: "createUser",
      target: {
        app: App.App1,
        type: ResourceType.UNKNOWN,
        id: "user-123",
      },
      status: "success",
    };

    it("should upsert a single item without resources", async () => {
      await service.upsertItem(baseInput);

      expect(mockStorage.upsertItem).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "createUser",
          target: baseInput.target,
        }),
        expect.objectContaining({
          number: 1,
          status: "success",
        }),
      );
      expect(mockStorage.upsertBatch).not.toHaveBeenCalled();
      expect(mockEvents.upserted).toHaveBeenCalledWith([
        expect.objectContaining({
          operation: "createUser",
        }),
      ]);
    });

    it("should create batch entries for resources with IDs", async () => {
      const inputWithResources: UpsertAuditInput = {
        ...baseInput,
        id: "parent-id",
        resources: [
          { app: App.App1, type: ResourceType.UNKNOWN, id: "resource-1" },
          { app: App.App1, type: ResourceType.UNKNOWN, id: "resource-2" },
        ],
      };

      await service.upsertItem(inputWithResources);

      // Main item goes through upsertItem
      expect(mockStorage.upsertItem).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "createUser" }),
        expect.any(Object),
      );

      // Related resources go through upsertBatch
      expect(mockStorage.upsertBatch).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "parent-id#App1.Unknown#resource-1",
          app: App.App1,
          type: ResourceType.UNKNOWN,
          source: baseInput.target,
        }),
        expect.objectContaining({
          id: "parent-id#App1.Unknown#resource-2",
          app: App.App1,
          type: ResourceType.UNKNOWN,
          source: baseInput.target,
        }),
      ]);
    });

    it("should filter out resources without IDs", async () => {
      const inputWithMixedResources: UpsertAuditInput = {
        ...baseInput,
        id: "parent-id",
        resources: [
          { app: App.App1, type: ResourceType.UNKNOWN, id: "has-id" },
          { app: App.App1, type: ResourceType.UNKNOWN }, // No id
        ],
      };

      await service.upsertItem(inputWithMixedResources);

      // Main item goes through upsertItem
      expect(mockStorage.upsertItem).toHaveBeenCalled();

      // Should only have 1 resource with ID in batch
      expect(mockStorage.upsertBatch).toHaveBeenCalledWith([
        expect.objectContaining({ id: "parent-id#App1.Unknown#has-id" }),
      ]);
      const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
      expect(batchArg).toHaveLength(1);
    });

    it("should set rerunable from parent when specified", async () => {
      const inputWithRerunable: UpsertAuditInput = {
        ...baseInput,
        id: "parent-id",
        rerunable: true,
        resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
      };

      await service.upsertItem(inputWithRerunable);

      const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
      expect(batchArg[0].rerunable).toBe(true);
    });

    it("should set rerunable based on event presence when not specified", async () => {
      const inputWithEvent: UpsertAuditInput = {
        ...baseInput,
        id: "parent-id",
        event: { detail: "test", "detail-type": "Test", source: "test" },
        resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
      };

      await service.upsertItem(inputWithEvent);

      const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
      expect(batchArg[0].rerunable).toBe(true);
    });

    it("should set rerunable to false when no event and not specified", async () => {
      const inputWithoutEvent: UpsertAuditInput = {
        ...baseInput,
        id: "parent-id",
        resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
      };

      await service.upsertItem(inputWithoutEvent);

      const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
      expect(batchArg[0].rerunable).toBe(false);
    });

    it("should clear event, result, error from child resources", async () => {
      const inputWithExtras: UpsertAuditInput = {
        ...baseInput,
        id: "parent-id",
        event: { detail: "test", "detail-type": "Test", source: "test" },
        error: new Error("test error"),
        resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
      };

      await service.upsertItem(inputWithExtras);

      const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
      expect(batchArg[0].event).toBeUndefined();
      expect(batchArg[0].error).toBeUndefined();
    });

    it("should not call events.upserted when events is null", async () => {
      const serviceWithoutEvents = new AuditService(
        mockLogger as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[0],
        testConfig,
        mockStorage as unknown as ConstructorParameters<typeof AuditService<typeof testConfig>>[2],
        null,
      );

      await serviceWithoutEvents.upsertItem(baseInput);

      expect(mockStorage.upsertItem).toHaveBeenCalled();
      // No error should be thrown
    });

    it("should handle empty resources array", async () => {
      const inputWithEmptyResources: UpsertAuditInput = {
        ...baseInput,
        resources: [],
      };

      await service.upsertItem(inputWithEmptyResources);

      expect(mockStorage.upsertItem).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "createUser" }),
        expect.any(Object),
      );
      expect(mockStorage.upsertBatch).not.toHaveBeenCalled();
    });

    describe("attempt tracking", () => {
      it("should pass current attempt to upsertItem", async () => {
        await service.upsertItem({
          ...baseInput,
          id: "new-audit-id",
        });

        expect(mockStorage.upsertItem).toHaveBeenCalledWith(
          expect.objectContaining({ id: "new-audit-id" }),
          expect.objectContaining({
            number: 1,
            status: "success",
          }),
        );
        // Verify attempt has 'at' timestamp
        const attemptArg = mockStorage.upsertItem.mock.calls[0][1];
        expect(attemptArg.at).toBeDefined();
      });

      it("should call upsertItem with the item and attempt", async () => {
        // Simulate retry scenario where upsertItem returns 2
        mockStorage.upsertItem.mockResolvedValue(2);

        await service.upsertItem({
          ...baseInput,
          id: "existing-audit-id",
          status: "success",
        });

        // Verify upsertItem was called with item and attempt object
        expect(mockStorage.upsertItem).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "existing-audit-id",
            status: "success",
          }),
          expect.objectContaining({
            status: "success",
            at: expect.any(String),
          }),
        );
      });

      it("should capture error in attempt record when status is fail", async () => {
        await service.upsertItem({
          ...baseInput,
          id: "new-audit-id",
          status: "fail",
          error: "Connection refused",
        });

        expect(mockStorage.upsertItem).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            number: 1,
            status: "fail",
            error: "Connection refused",
          }),
        );
      });

      it("should not copy attempts to related resources", async () => {
        await service.upsertItem({
          ...baseInput,
          id: "parent-id",
          resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
        });

        // Main item goes through upsertItem with attempt
        expect(mockStorage.upsertItem).toHaveBeenCalled();

        // Child resource should not have attempts
        const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
        expect(batchArg[0].attempts).toBeUndefined();
      });

      it("should pass attempt to upsertItem when no id provided", async () => {
        await service.upsertItem({
          ...baseInput,
          // No id - will be auto-generated
        });

        expect(mockStorage.upsertItem).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            number: 1,
          }),
        );
      });
    });
  });

  describe("listItems", () => {
    const mockResponse = {
      items: [{ id: "audit-1" }, { id: "audit-2" }],
      pagination: { nextToken: "token123" },
    };

    it("should return list items from storage", async () => {
      mockStorage.listItems.mockResolvedValue(mockResponse);

      const result = await service.listItems({
        app: App.App1,
        resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
      });

      expect(result).toEqual(mockResponse);
      expect(mockStorage.listItems).toHaveBeenCalled();
    });

    it("should pass pagination parameters", async () => {
      mockStorage.listItems.mockResolvedValue(mockResponse);

      await service.listItems(
        {
          app: App.App1,
          resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
        },
        { pageSize: 10, nextToken: "abc" },
      );

      expect(mockStorage.listItems).toHaveBeenCalledWith(
        {
          app: App.App1,
          resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
        },
        { pageSize: 10, nextToken: "abc" },
      );
    });

    it("should rethrow async errors from storage", async () => {
      const error = new Error("Storage error");
      mockStorage.listItems.mockRejectedValue(error);

      await expect(
        service.listItems({
          app: App.App1,
          resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
        }),
      ).rejects.toThrow("Storage error");

      // Note: The try-catch in the code doesn't actually catch async errors
      // because the promise is returned directly without await.
      // This is a known limitation - errors propagate but aren't logged.
    });

    it("should log and rethrow synchronous errors", async () => {
      const error = new Error("Sync storage error");
      mockStorage.listItems.mockImplementation(() => {
        throw error;
      });

      await expect(
        service.listItems({
          app: App.App1,
          resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
        }),
      ).rejects.toThrow("Sync storage error");

      expect(mockLogger.error).toHaveBeenCalledWith(
        "An error occurred while trying to list items",
        { error },
      );
    });
  });

  describe("listTraceItems", () => {
    const mockResponse = {
      items: [{ id: "trace-audit-1" }, { id: "trace-audit-2" }],
      pagination: {},
    };

    it("should return trace items from storage", async () => {
      mockStorage.listTraceItems.mockResolvedValue(mockResponse);

      const result = await service.listTraceItems({
        trace: "trace-abc-123",
      });

      expect(result).toEqual(mockResponse);
      expect(mockStorage.listTraceItems).toHaveBeenCalledWith(
        { trace: "trace-abc-123" },
        undefined,
      );
    });

    it("should pass pagination parameters", async () => {
      mockStorage.listTraceItems.mockResolvedValue(mockResponse);

      await service.listTraceItems({ trace: "trace-abc-123" }, { pageSize: 5, nextToken: "xyz" });

      expect(mockStorage.listTraceItems).toHaveBeenCalledWith(
        { trace: "trace-abc-123" },
        { pageSize: 5, nextToken: "xyz" },
      );
    });

    it("should rethrow errors from storage", async () => {
      const error = new Error("Trace query failed");
      mockStorage.listTraceItems.mockRejectedValue(error);

      await expect(service.listTraceItems({ trace: "trace-abc-123" })).rejects.toThrow(
        "Trace query failed",
      );

      // Note: The try-catch in the code doesn't actually catch async errors
      // because the promise is returned directly without await.
      // This is a known limitation - errors propagate but aren't logged.
    });

    it("should log and rethrow synchronous errors", async () => {
      const error = new Error("Sync trace query error");
      mockStorage.listTraceItems.mockImplementation(() => {
        throw error;
      });

      await expect(service.listTraceItems({ trace: "trace-abc-123" })).rejects.toThrow(
        "Sync trace query error",
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        "An error occurred while trying to list trace items",
        { error },
      );
    });
  });
});
