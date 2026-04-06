import { EventType } from "@aws-lambda-powertools/batch";
import type { SQSRecord } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Audits } from "../audits.js";
import type { AuditConfig } from "../config.js";
import type { LogAuditInput } from "../schema/log.js";
import { Status } from "../schema/log.js";
import { App, ResourceType } from "../test-config.js";
// Import from index.ts to ensure barrel file coverage
import { AuditBatchProcessor, type MessageWithAuditOverride } from "./index.js";

// Mock the utils module
vi.mock("../utils.js", () => ({
  extractOverridesFromBatchProcessor: vi.fn((result) => {
    if (result && typeof result === "object") {
      if ("_audit" in result) {
        const auditOverrides = result._audit || {};
        const rootMessage = "message" in result ? result.message : undefined;
        return {
          ...auditOverrides,
          message: [rootMessage, auditOverrides?.message].filter(Boolean).join(" "),
        };
      }
      if ("message" in result) {
        return { message: result.message };
      }
    }
    return {};
  }),
  normalizeEventBridgetEventBody: vi.fn((eventType, record) => {
    if (eventType === EventType.SQS) {
      const sqsRecord = record as SQSRecord;
      const bodyObject = JSON.parse(sqsRecord.body);
      return {
        detail: bodyObject?.detail,
        "detail-type": bodyObject?.["detail-type"],
        source: bodyObject?.source,
      };
    }
    return undefined;
  }),
  getRecordId: vi.fn((eventType, record) => {
    if (eventType === EventType.SQS) {
      return (record as SQSRecord).messageId;
    }
    if (eventType === EventType.KinesisDataStreams) {
      return (record as { eventID: string }).eventID;
    }
    if (eventType === EventType.DynamoDBStreams) {
      return (record as { eventID: string }).eventID;
    }
    return undefined;
  }),
}));

describe("AuditBatchProcessor", () => {
  let mockAudits: Audits<AuditConfig>;
  let createAuditItem: (record: SQSRecord, overrides?: Partial<LogAuditInput>) => LogAuditInput;
  let processor: AuditBatchProcessor<SQSRecord>;

  const createMockSQSRecord = (body: object = {}): SQSRecord => ({
    messageId: "test-message-id",
    receiptHandle: "test-receipt-handle",
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1234567890",
      SenderId: "test-sender",
      ApproximateFirstReceiveTimestamp: "1234567890",
    },
    messageAttributes: {},
    md5OfBody: "test-md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:test-queue",
    awsRegion: "us-east-1",
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockAudits = {
      addAudit: vi.fn(),
      publishStoredAudits: vi.fn(),
    } as unknown as Audits<AuditConfig>;

    createAuditItem = vi.fn((record: SQSRecord, overrides?: Partial<LogAuditInput>) => ({
      operation: "processMessage",
      target: {
        app: App.App1,
        type: ResourceType.UNKNOWN,
        id: record.messageId,
      },
      ...overrides,
    })) as (record: SQSRecord, overrides?: Partial<LogAuditInput>) => LogAuditInput;

    processor = new AuditBatchProcessor(EventType.SQS, mockAudits, createAuditItem);
  });

  describe("constructor", () => {
    it("should create an instance with the correct event type", () => {
      expect(processor).toBeInstanceOf(AuditBatchProcessor);
      expect(processor.audit).toBe(mockAudits);
      expect(processor.createAuditItem).toBe(createAuditItem);
    });

    it("should extend BatchProcessor", () => {
      expect(processor.eventType).toBe(EventType.SQS);
    });
  });

  describe("successHandler", () => {
    it("should create a success audit entry with basic result", () => {
      const record = createMockSQSRecord({ detail: { test: "data" } });
      const result = "Success";

      processor.successHandler(record, result);

      expect(mockAudits.addAudit).toHaveBeenCalledTimes(1);
      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.SUCCESS,
      });

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.event).toBeUndefined();
    });

    it("should extract message from result object", () => {
      const record = createMockSQSRecord();
      const result = { message: "Operation completed successfully" };

      processor.successHandler(record, result);

      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.SUCCESS,
        message: "Operation completed successfully",
      });
    });

    it("should apply audit overrides from MessageWithAuditOverride", () => {
      const record = createMockSQSRecord();
      const result: MessageWithAuditOverride = {
        message: "Base message",
        _audit: {
          message: "Additional context",
          tier: 3,
        },
      };

      processor.successHandler(record, result);

      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.SUCCESS,
        message: "Base message Additional context",
        tier: 3,
      });
    });

    it("should handle null result", () => {
      const record = createMockSQSRecord();

      processor.successHandler(record, null);

      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.SUCCESS,
      });
    });

    it("should handle undefined result", () => {
      const record = createMockSQSRecord();

      processor.successHandler(record, undefined);

      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.SUCCESS,
      });
    });

    it("should not store event data on success", () => {
      const record = createMockSQSRecord({
        detail: { sensitive: "data" },
        "detail-type": "TestEvent",
        source: "test.source",
      });

      processor.successHandler(record, "Success");

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.event).toBeUndefined();
    });
  });

  describe("failureHandler", () => {
    it("should create a failure audit entry with error details", () => {
      const record = createMockSQSRecord({
        detail: { test: "data" },
        "detail-type": "TestEvent",
        source: "test.source",
      });
      const error = new Error("Processing failed");

      processor.failureHandler(record, error);

      expect(mockAudits.addAudit).toHaveBeenCalledTimes(1);
      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.FAIL,
        event: {
          detail: { test: "data" },
          "detail-type": "TestEvent",
          source: "test.source",
        },
        message: "Processing failed",
      });

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.error).toBe(error);
    });

    it("should include the original event body for debugging", () => {
      const eventBody = {
        detail: { orderId: "12345", action: "process" },
        "detail-type": "OrderEvent",
        source: "orders.service",
      };
      const record = createMockSQSRecord(eventBody);
      const error = new Error("Order processing failed");

      processor.failureHandler(record, error);

      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.FAIL,
        event: {
          detail: { orderId: "12345", action: "process" },
          "detail-type": "OrderEvent",
          source: "orders.service",
        },
        message: "Order processing failed",
      });
    });

    it("should handle errors with custom properties", () => {
      const record = createMockSQSRecord();
      const error = new Error("Custom error");
      (error as Error & { code: string }).code = "ERR_CUSTOM";

      processor.failureHandler(record, error);

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.error).toBe(error);
      expect((auditCall.error as Error & { code: string }).code).toBe("ERR_CUSTOM");
    });

    it("should handle errors with empty message", () => {
      const record = createMockSQSRecord();
      const error = new Error("");

      processor.failureHandler(record, error);

      expect(createAuditItem).toHaveBeenCalledWith(record, {
        status: Status.FAIL,
        event: expect.any(Object),
        message: "",
      });
    });
  });

  describe("integration scenarios", () => {
    it("should handle mixed success and failure in batch", () => {
      const successRecord = createMockSQSRecord({ id: "success-1" });
      const failureRecord = createMockSQSRecord({ id: "failure-1" });
      const error = new Error("Failed to process");

      processor.successHandler(successRecord, { message: "Processed" });
      processor.failureHandler(failureRecord, error);

      expect(mockAudits.addAudit).toHaveBeenCalledTimes(2);

      const [successCall, failureCall] = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(successCall[0].event).toBeUndefined();
      expect(failureCall[0].error).toBe(error);
    });

    it("should preserve createAuditItem context across calls", () => {
      const records = [
        createMockSQSRecord({ id: "1" }),
        createMockSQSRecord({ id: "2" }),
        createMockSQSRecord({ id: "3" }),
      ];

      for (const record of records) {
        processor.successHandler(record, "OK");
      }

      expect(createAuditItem).toHaveBeenCalledTimes(3);
      expect(mockAudits.addAudit).toHaveBeenCalledTimes(3);
    });
  });

  describe("auto-correlation with record ID", () => {
    it("should auto-set audit id from SQS messageId on success", () => {
      const record = createMockSQSRecord({});

      processor.successHandler(record, "Success");

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.id).toBe("test-message-id");
    });

    it("should auto-set audit id from SQS messageId on failure", () => {
      const record = createMockSQSRecord({});
      const error = new Error("Failed");

      processor.failureHandler(record, error);

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.id).toBe("test-message-id");
    });

    it("should not override existing audit id on success", () => {
      // Create a processor with createAuditItem that sets an id
      const createAuditItemWithId = vi.fn(
        (record: SQSRecord, overrides?: Partial<LogAuditInput>) => ({
          id: "custom-audit-id",
          operation: "processMessage",
          target: {
            app: App.App1,
            type: ResourceType.UNKNOWN,
            id: record.messageId,
          },
          ...overrides,
        }),
      ) as (record: SQSRecord, overrides?: Partial<LogAuditInput>) => LogAuditInput;

      const processorWithId = new AuditBatchProcessor(
        EventType.SQS,
        mockAudits,
        createAuditItemWithId,
      );

      const record = createMockSQSRecord({});
      processorWithId.successHandler(record, "Success");

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.id).toBe("custom-audit-id");
    });

    it("should not override existing audit id on failure", () => {
      // Create a processor with createAuditItem that sets an id
      const createAuditItemWithId = vi.fn(
        (record: SQSRecord, overrides?: Partial<LogAuditInput>) => ({
          id: "custom-audit-id",
          operation: "processMessage",
          target: {
            app: App.App1,
            type: ResourceType.UNKNOWN,
            id: record.messageId,
          },
          ...overrides,
        }),
      ) as (record: SQSRecord, overrides?: Partial<LogAuditInput>) => LogAuditInput;

      const processorWithId = new AuditBatchProcessor(
        EventType.SQS,
        mockAudits,
        createAuditItemWithId,
      );

      const record = createMockSQSRecord({});
      const error = new Error("Failed");
      processorWithId.failureHandler(record, error);

      const auditCall = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(auditCall.id).toBe("custom-audit-id");
    });

    it("should use same messageId for retry correlation", () => {
      const record1 = createMockSQSRecord({});
      const record2 = {
        ...createMockSQSRecord({}),
        messageId: "test-message-id",
      }; // Same messageId simulating retry
      const error = new Error("Failed");

      processor.failureHandler(record1, error);
      processor.successHandler(record2, "Success on retry");

      const [failCall, successCall] = (mockAudits.addAudit as ReturnType<typeof vi.fn>).mock.calls;
      expect(failCall[0].id).toBe("test-message-id");
      expect(successCall[0].id).toBe("test-message-id");
    });
  });
});
