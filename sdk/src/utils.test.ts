import { EventType } from "@aws-lambda-powertools/batch";
import type {
	DynamoDBRecord,
	KinesisStreamRecord,
	SQSRecord,
} from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { LogAuditInput } from "./schema/log.js";
import { App, ResourceType } from "./test-config.js";
import {
	buildAudit,
	buildAuditFromSQSRecord,
	extractOverridesFromBatchProcessor,
	generateAuditId,
	getReceiveCount,
	getRecordId,
	getTraceParts,
	isRetry,
	normalizeEventBridgetEventBody,
	normalizeEventBridgetInput,
	normalizeSQSEventBody,
} from "./utils.js";

// Helper to create a valid audit item
function createAuditItem(
	overrides: Partial<LogAuditInput> = {},
): LogAuditInput {
	return {
		operation: "testOperation",
		target: {
			app: App.App1,
			type: ResourceType.UNKNOWN,
			id: "test-id",
		},
		...overrides,
	};
}

// Helper to create a mock SQS record
function createMockSQSRecord(body: object = {}): SQSRecord {
	return {
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
	};
}

describe("utils", () => {
	describe("generateAuditId", () => {
		it("should generate a valid KSUID", () => {
			const auditId = generateAuditId();

			// KSUIDs are 27 characters long and base62 encoded
			expect(auditId).toHaveLength(27);
			expect(auditId).toMatch(/^[0-9a-zA-Z]+$/);
		});

		it("should generate unique IDs", () => {
			const id1 = generateAuditId();
			const id2 = generateAuditId();

			expect(id1).not.toBe(id2);
		});
	});

	describe("buildAudit", () => {
		it("should return the audit unchanged when no overrides", () => {
			const audit = createAuditItem({ message: "Original message" });

			const result = buildAudit(audit);

			expect(result.operation).toBe("testOperation");
			expect(result.message).toBe("Original message");
		});

		it("should merge overrides into the audit", () => {
			const audit = createAuditItem();
			const overrides = { status: "success" as const, tier: 3 };

			const result = buildAudit(audit, overrides);

			expect(result.status).toBe("success");
			expect(result.tier).toBe(3);
		});

		it("should concatenate messages from audit and overrides", () => {
			const audit = createAuditItem({ message: "Base message" });
			const overrides = { message: "additional context" };

			const result = buildAudit(audit, overrides);

			expect(result.message).toBe("Base message additional context");
		});

		it("should handle audit without message", () => {
			const audit = createAuditItem();
			const overrides = { message: "Override message" };

			const result = buildAudit(audit, overrides);

			expect(result.message).toBe("Override message");
		});

		it("should handle overrides without message", () => {
			const audit = createAuditItem({ message: "Audit message" });
			const overrides = { status: "fail" as const };

			const result = buildAudit(audit, overrides);

			expect(result.message).toBe("Audit message");
		});

		it("should handle empty overrides", () => {
			const audit = createAuditItem({ message: "Test" });

			const result = buildAudit(audit, {});

			expect(result.message).toBe("Test");
		});

		it("should deeply merge nested objects", () => {
			const audit = createAuditItem({
				context: { key1: "value1", nested: { a: 1 } },
			});
			const overrides = {
				context: { key2: "value2", nested: { b: 2 } },
			};

			const result = buildAudit(audit, overrides);

			expect(result.context).toEqual({
				key1: "value1",
				key2: "value2",
				nested: { a: 1, b: 2 },
			});
		});
	});

	describe("buildAuditFromSQSRecord", () => {
		it("should extract trace from SQS record body when audit has no trace", () => {
			const sqsRecord = createMockSQSRecord({
				detail: {
					transaction: { trace: "trace-abc:3" },
				},
			});
			const audit = createAuditItem();

			const result = buildAuditFromSQSRecord(sqsRecord, audit);

			// Should increment the stage from 3 to 4
			expect(result.trace).toBe("trace-abc:4");
		});

		it("should not override existing trace on audit", () => {
			const sqsRecord = createMockSQSRecord({
				detail: {
					transaction: { trace: "sqs-trace:1" },
				},
			});
			const audit = createAuditItem({ trace: "existing-trace:5" });

			const result = buildAuditFromSQSRecord(sqsRecord, audit);

			expect(result.trace).toBe("existing-trace:5");
		});

		it("should handle SQS record without transaction trace", () => {
			const sqsRecord = createMockSQSRecord({
				detail: { someData: "value" },
			});
			const audit = createAuditItem();

			const result = buildAuditFromSQSRecord(sqsRecord, audit);

			expect(result.trace).toBeUndefined();
		});

		it("should handle trace without stage (defaults to 1 then increments to 2)", () => {
			const sqsRecord = createMockSQSRecord({
				detail: {
					transaction: { trace: "trace-no-stage" },
				},
			});
			const audit = createAuditItem();

			const result = buildAuditFromSQSRecord(sqsRecord, audit);

			// No stage means it defaults to 1, then increments to 2
			expect(result.trace).toBe("trace-no-stage:2");
		});

		it("should apply overrides correctly", () => {
			const sqsRecord = createMockSQSRecord({ detail: {} });
			const audit = createAuditItem({ message: "Base" });
			const overrides = { message: "Override", status: "success" as const };

			const result = buildAuditFromSQSRecord(sqsRecord, audit, overrides);

			expect(result.message).toBe("Base Override");
			expect(result.status).toBe("success");
		});
	});

	describe("normalizeEventBridgetInput", () => {
		it("should convert AWS SDK format to internal format", () => {
			const input = {
				Detail: '{"orderId": "123"}',
				DetailType: "OrderCreated",
				Source: "orders.service",
			};

			const result = normalizeEventBridgetInput(input);

			expect(result).toEqual({
				detail: '{"orderId": "123"}',
				"detail-type": "OrderCreated",
				source: "orders.service",
			});
		});

		it("should handle undefined values", () => {
			const input = {
				Detail: undefined,
				DetailType: undefined,
				Source: undefined,
			};

			const result = normalizeEventBridgetInput(input);

			expect(result).toEqual({
				detail: undefined,
				"detail-type": undefined,
				source: undefined,
			});
		});
	});

	describe("extractOverridesFromBatchProcessor", () => {
		it("should return empty object for null", () => {
			const result = extractOverridesFromBatchProcessor(null);

			expect(result).toEqual({});
		});

		it("should return empty object for undefined", () => {
			const result = extractOverridesFromBatchProcessor(undefined);

			expect(result).toEqual({});
		});

		it("should return empty object for string", () => {
			const result = extractOverridesFromBatchProcessor("success");

			expect(result).toEqual({});
		});

		it("should return empty object for number", () => {
			const result = extractOverridesFromBatchProcessor(42);

			expect(result).toEqual({});
		});

		it("should extract message from object", () => {
			const result = extractOverridesFromBatchProcessor({ message: "Done" });

			expect(result).toEqual({ message: "Done" });
		});

		it("should return empty object for object without message or _audit", () => {
			const result = extractOverridesFromBatchProcessor({ other: "data" });

			expect(result).toEqual({});
		});

		it("should extract _audit overrides", () => {
			const result = extractOverridesFromBatchProcessor({
				_audit: { status: "success", tier: 3 },
			});

			expect(result).toEqual({ status: "success", tier: 3, message: "" });
		});

		it("should combine message and _audit overrides", () => {
			const result = extractOverridesFromBatchProcessor({
				message: "Processed",
				_audit: { status: "success" },
			});

			expect(result).toEqual({ status: "success", message: "Processed" });
		});

		it("should concatenate root message and _audit message", () => {
			const result = extractOverridesFromBatchProcessor({
				message: "Base",
				_audit: { message: "context" },
			});

			expect(result).toEqual({ message: "Base context" });
		});

		it("should handle _audit with null value", () => {
			const result = extractOverridesFromBatchProcessor({
				message: "Test",
				_audit: null,
			});

			expect(result).toEqual({ message: "Test" });
		});

		it("should handle _audit with non-object value", () => {
			const result = extractOverridesFromBatchProcessor({
				message: "Test",
				_audit: "invalid",
			});

			expect(result).toEqual({ message: "Test" });
		});

		it("should handle object with non-string message", () => {
			const result = extractOverridesFromBatchProcessor({
				message: 123,
			});

			expect(result).toEqual({});
		});
	});

	describe("normalizeEventBridgetEventBody", () => {
		it("should normalize SQS event body", () => {
			const sqsRecord = createMockSQSRecord({
				detail: { orderId: "123" },
				"detail-type": "OrderCreated",
				source: "orders.service",
			});

			const result = normalizeEventBridgetEventBody(EventType.SQS, sqsRecord);

			expect(result).toEqual({
				detail: { orderId: "123" },
				"detail-type": "OrderCreated",
				source: "orders.service",
			});
		});

		it("should return undefined for unsupported event types", () => {
			const sqsRecord = createMockSQSRecord({});

			const result = normalizeEventBridgetEventBody(
				EventType.KinesisDataStreams,
				sqsRecord,
			);

			expect(result).toBeUndefined();
		});

		it("should return undefined for DynamoDB event type", () => {
			const sqsRecord = createMockSQSRecord({});

			const result = normalizeEventBridgetEventBody(
				EventType.DynamoDBStreams,
				sqsRecord,
			);

			expect(result).toBeUndefined();
		});
	});

	describe("normalizeSQSEventBody", () => {
		it("should extract EventBridge fields from SQS body", () => {
			const sqsRecord = createMockSQSRecord({
				detail: { data: "value" },
				"detail-type": "TestEvent",
				source: "test.source",
			});

			const result = normalizeSQSEventBody(sqsRecord);

			expect(result).toEqual({
				detail: { data: "value" },
				"detail-type": "TestEvent",
				source: "test.source",
			});
		});

		it("should handle empty body", () => {
			const sqsRecord = createMockSQSRecord({});

			const result = normalizeSQSEventBody(sqsRecord);

			expect(result).toEqual({
				detail: undefined,
				"detail-type": undefined,
				source: undefined,
			});
		});

		it("should handle partial EventBridge fields", () => {
			const sqsRecord = createMockSQSRecord({
				detail: { partial: true },
			});

			const result = normalizeSQSEventBody(sqsRecord);

			expect(result).toEqual({
				detail: { partial: true },
				"detail-type": undefined,
				source: undefined,
			});
		});
	});

	describe("getTraceParts", () => {
		it("should parse trace ID with stage", () => {
			const result = getTraceParts("abc-123:5");

			expect(result).toEqual({ id: "abc-123", stage: 5 });
		});

		it("should default stage to 0 when not present", () => {
			const result = getTraceParts("abc-123");

			expect(result).toEqual({ id: "abc-123", stage: 0 });
		});

		it("should handle stage of 0", () => {
			const result = getTraceParts("trace-id:0");

			expect(result).toEqual({ id: "trace-id", stage: 0 });
		});

		it("should handle large stage numbers", () => {
			const result = getTraceParts("trace:999");

			expect(result).toEqual({ id: "trace", stage: 999 });
		});

		it("should handle trace ID with colons in id part", () => {
			const result = getTraceParts("id:with:colons:5");

			// Only splits on first colon
			expect(result.id).toBe("id");
			expect(result.stage).toBe(NaN); // "with:colons:5" is not a number
		});
	});

	describe("getRecordId", () => {
		it("should return messageId for SQS records", () => {
			const sqsRecord = createMockSQSRecord({});

			const result = getRecordId(EventType.SQS, sqsRecord);

			expect(result).toBe("test-message-id");
		});

		it("should return eventID for Kinesis records", () => {
			const kinesisRecord: KinesisStreamRecord = {
				eventID: "kinesis-event-123",
				eventVersion: "1.0",
				kinesis: {
					partitionKey: "partition-1",
					data: "",
					kinesisSchemaVersion: "1.0",
					sequenceNumber: "12345",
					approximateArrivalTimestamp: 1234567890,
				},
				invokeIdentityArn: "arn:aws:lambda:...",
				eventName: "aws:kinesis:record",
				eventSourceARN: "arn:aws:kinesis:...",
				eventSource: "aws:kinesis",
				awsRegion: "us-east-1",
			};

			const result = getRecordId(EventType.KinesisDataStreams, kinesisRecord);

			expect(result).toBe("kinesis-event-123");
		});

		it("should return eventID for DynamoDB Streams records", () => {
			const dynamoRecord: DynamoDBRecord = {
				eventID: "dynamodb-event-456",
				eventVersion: "1.0",
				dynamodb: {
					Keys: {},
					StreamViewType: "NEW_AND_OLD_IMAGES",
				},
				eventSourceARN: "arn:aws:dynamodb:...",
				eventSource: "aws:dynamodb",
				awsRegion: "us-east-1",
			};

			const result = getRecordId(EventType.DynamoDBStreams, dynamoRecord);

			expect(result).toBe("dynamodb-event-456");
		});

		it("should return undefined for unknown event type", () => {
			const sqsRecord = createMockSQSRecord({});

			const result = getRecordId(
				"Unknown" as keyof typeof EventType,
				sqsRecord,
			);

			expect(result).toBeUndefined();
		});
	});

	describe("getReceiveCount", () => {
		it("should return 1 for first delivery", () => {
			const sqsRecord = createMockSQSRecord({});

			const result = getReceiveCount(sqsRecord);

			expect(result).toBe(1);
		});

		it("should return 2 for first retry", () => {
			const sqsRecord: SQSRecord = {
				...createMockSQSRecord({}),
				attributes: {
					...createMockSQSRecord({}).attributes,
					ApproximateReceiveCount: "2",
				},
			};

			const result = getReceiveCount(sqsRecord);

			expect(result).toBe(2);
		});

		it("should return 5 for fourth retry", () => {
			const sqsRecord: SQSRecord = {
				...createMockSQSRecord({}),
				attributes: {
					...createMockSQSRecord({}).attributes,
					ApproximateReceiveCount: "5",
				},
			};

			const result = getReceiveCount(sqsRecord);

			expect(result).toBe(5);
		});
	});

	describe("isRetry", () => {
		it("should return false for first delivery (count = 1)", () => {
			const sqsRecord = createMockSQSRecord({});

			const result = isRetry(sqsRecord);

			expect(result).toBe(false);
		});

		it("should return true for first retry (count = 2)", () => {
			const sqsRecord: SQSRecord = {
				...createMockSQSRecord({}),
				attributes: {
					...createMockSQSRecord({}).attributes,
					ApproximateReceiveCount: "2",
				},
			};

			const result = isRetry(sqsRecord);

			expect(result).toBe(true);
		});

		it("should return true for subsequent retries (count > 2)", () => {
			const sqsRecord: SQSRecord = {
				...createMockSQSRecord({}),
				attributes: {
					...createMockSQSRecord({}).attributes,
					ApproximateReceiveCount: "10",
				},
			};

			const result = isRetry(sqsRecord);

			expect(result).toBe(true);
		});
	});
});
