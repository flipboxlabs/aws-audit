import type { Logger } from "@aws-lambda-powertools/logger";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EventBridge } from "../constants.js";
import type { UpsertAudit } from "../schema/service.js";
import { App, ResourceType } from "../test-config.js";
// Import from index.ts to ensure barrel file coverage
import { AuditEventBus, type BatchHandler } from "./index.js";

describe("AuditEventBus", () => {
  let mockHandler: {
    putEvents: ReturnType<typeof vi.fn>;
  };
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    critical: ReturnType<typeof vi.fn>;
  };
  let eventBus: AuditEventBus;

  const createMockAudit = (overrides: Partial<UpsertAudit> = {}): UpsertAudit =>
    ({
      id: "audit-123",
      operation: "testOperation",
      status: "success",
      tier: 2,
      target: {
        app: App.App1,
        type: ResourceType.UNKNOWN,
        id: "resource-123",
      },
      ...overrides,
    }) as UpsertAudit;

  beforeEach(() => {
    vi.clearAllMocks();

    mockHandler = {
      putEvents: vi.fn().mockResolvedValue([]),
    };

    mockLogger = {
      debug: vi.fn(),
      critical: vi.fn(),
    };

    eventBus = new AuditEventBus(
      mockLogger as unknown as Logger,
      mockHandler as unknown as BatchHandler,
    );
  });

  describe("constructor", () => {
    it("should create an instance with provided handler", () => {
      expect(eventBus).toBeInstanceOf(AuditEventBus);
    });

    it("should create default handler when not provided", () => {
      // Test that constructor works without handler parameter
      const busWithDefaults = new AuditEventBus(mockLogger as unknown as Logger);

      expect(busWithDefaults).toBeInstanceOf(AuditEventBus);
    });
  });

  describe("upserted", () => {
    it("should publish single audit event", async () => {
      const audit = createMockAudit();

      await eventBus.upserted([audit]);

      expect(mockHandler.putEvents).toHaveBeenCalledTimes(1);
      expect(mockHandler.putEvents).toHaveBeenCalledWith([
        expect.objectContaining({
          EventBusName: EventBridge.Bus.Name(),
          DetailType: EventBridge.DetailType.UPSERTED,
          Source: EventBridge.Source,
          Detail: expect.any(String),
        }),
      ]);
    });

    it("should serialize audit in Detail field", async () => {
      const audit = createMockAudit({ operation: "createUser" });

      await eventBus.upserted([audit]);

      const callArgs = mockHandler.putEvents.mock.calls[0][0];
      const detail = JSON.parse(callArgs[0].Detail);

      expect(detail).toEqual({
        audit: expect.objectContaining({
          operation: "createUser",
        }),
      });
    });

    it("should publish multiple audit events", async () => {
      const audits = [
        createMockAudit({ id: "audit-1", operation: "op1" }),
        createMockAudit({ id: "audit-2", operation: "op2" }),
        createMockAudit({ id: "audit-3", operation: "op3" }),
      ];

      await eventBus.upserted(audits);

      expect(mockHandler.putEvents).toHaveBeenCalledTimes(1);
      const callArgs = mockHandler.putEvents.mock.calls[0][0];
      expect(callArgs).toHaveLength(3);
    });

    it("should include extra events when provided", async () => {
      const audit = createMockAudit();
      const extraEvents = [
        {
          DetailType: "CustomEvent",
          Detail: '{"custom":"data"}',
          Source: "custom",
        },
        { DetailType: "AnotherEvent", Detail: "{}", Source: "another" },
      ];

      await eventBus.upserted([audit], extraEvents);

      const callArgs = mockHandler.putEvents.mock.calls[0][0];
      expect(callArgs).toHaveLength(3); // 1 audit + 2 extra
      expect(callArgs[1]).toEqual(extraEvents[0]);
      expect(callArgs[2]).toEqual(extraEvents[1]);
    });

    it("should handle empty extra events array", async () => {
      const audit = createMockAudit();

      await eventBus.upserted([audit], []);

      const callArgs = mockHandler.putEvents.mock.calls[0][0];
      expect(callArgs).toHaveLength(1);
    });

    it("should handle undefined extra events", async () => {
      const audit = createMockAudit();

      await eventBus.upserted([audit], undefined);

      const callArgs = mockHandler.putEvents.mock.calls[0][0];
      expect(callArgs).toHaveLength(1);
    });

    it("should return results from handler", async () => {
      const expectedResults = [{ EventId: "event-1" }, { EventId: "event-2" }];
      mockHandler.putEvents.mockResolvedValue(expectedResults);

      const audit = createMockAudit();
      const result = await eventBus.upserted([audit]);

      expect(result).toEqual(expectedResults);
    });

    it("should handle empty audits array", async () => {
      await eventBus.upserted([]);

      expect(mockHandler.putEvents).toHaveBeenCalledWith([]);
    });

    it("should use correct EventBridge configuration", async () => {
      const audit = createMockAudit();

      await eventBus.upserted([audit]);

      const callArgs = mockHandler.putEvents.mock.calls[0][0];
      expect(callArgs[0].EventBusName).toBe(EventBridge.Bus.Name());
      expect(callArgs[0].DetailType).toBe("Upserted");
      expect(callArgs[0].Source).toBe("Audit");
    });
  });

  describe("createDetail", () => {
    it("should wrap audit in AuditEventDetail structure", async () => {
      // Access protected method through upserted
      const audit = createMockAudit({
        id: "test-id",
        operation: "testOp",
      });

      await eventBus.upserted([audit]);

      const callArgs = mockHandler.putEvents.mock.calls[0][0];
      const detail = JSON.parse(callArgs[0].Detail);

      expect(detail).toHaveProperty("audit");
      expect(detail.audit.id).toBe("test-id");
      expect(detail.audit.operation).toBe("testOp");
    });
  });
});
