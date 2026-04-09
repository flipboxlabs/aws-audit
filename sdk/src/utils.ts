import { EventType } from "@aws-lambda-powertools/batch";
import type { EventSourceDataClassTypes } from "@aws-lambda-powertools/batch/types";
import type { PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import type { DynamoDBRecord, KinesisStreamRecord, SQSRecord } from "aws-lambda";
import KSUID from "ksuid";
import merge from "lodash.merge";
import type { MessageWithAuditOverride } from "./batch/batch-processor.js";
import type { LogAuditInput } from "./schema/log.js";
import type { EventBridgeEvent } from "./schema/model.js";

/**
 * Generates a unique, time-sortable audit ID using KSUID.
 *
 * KSUIDs (K-Sortable Unique Identifiers) are globally unique and
 * naturally sort by creation time, making them ideal for audit logs.
 *
 * @returns A KSUID string
 *
 * @example
 * ```typescript
 * const id = generateAuditId();
 * // Returns something like "2KQHp1vF5AufI6Fp4pJUJYBCWKg"
 * ```
 */
export function generateAuditId(): string {
  return `${KSUID.randomSync().string}`;
}

/**
 * Increments the stage number in a trace ID.
 *
 * Trace IDs follow the format "id:stage" where stage is an integer.
 * If no stage exists, it defaults to 1 before incrementing.
 *
 * @param trace - The trace in "id:stage" format
 * @returns The trace with incremented stage number
 *
 * @internal
 */
function incrementTraceStage(traceId: string): string {
  const [id, stage] = traceId.split(":");

  const nextStage = Number(stage == null ? 1 : stage) + 1;

  return [id, nextStage].join(":");
}

/**
 * Builds an audit entry from an SQS record with optional overrides.
 *
 * Automatically extracts trace information from the SQS message body
 * if the audit doesn't already have a trace ID set.
 *
 * @param sqsRecord - The SQS record containing the message
 * @param audit - The base audit entry to build from
 * @param overrides - Optional overrides to merge into the audit
 * @returns The complete audit entry with trace information
 *
 * @example
 * ```typescript
 * const audit = buildAuditFromSQSRecord(sqsRecord, {
 *   operation: 'processOrder',
 *   target: { app: 'OrderService', type: 'Order', id: '123' },
 * });
 * ```
 */
export function buildAuditFromSQSRecord(
  sqsRecord: SQSRecord,
  audit: LogAuditInput,
  overrides?: Partial<LogAuditInput>,
): LogAuditInput {
  // If a trace isn't set, try to set it from the sqs record
  if (!audit.trace) {
    const { detail } = JSON.parse(sqsRecord.body);

    if (detail.transaction?.trace) {
      audit.trace = incrementTraceStage(detail.transaction.trace);
    }
  }

  return buildAudit(audit, overrides);
}

/**
 * Builds an audit entry by deeply merging the base audit with overrides.
 *
 * Messages from both the base audit and overrides are concatenated
 * with a space separator.
 *
 * @param audit - The base audit entry
 * @param overrides - Optional overrides to merge into the audit
 * @returns The merged audit entry
 *
 * @example
 * ```typescript
 * const audit = buildAudit(
 *   { operation: 'create', message: 'Creating user' },
 *   { message: 'with admin role', status: 'success' }
 * );
 * // Result: { operation: 'create', message: 'Creating user with admin role', status: 'success' }
 * ```
 */
export function buildAudit(
  audit: LogAuditInput,
  overrides?: Partial<LogAuditInput>,
): LogAuditInput {
  const message = [audit.message, overrides?.message].filter(Boolean).join(" ");

  return merge(audit, overrides || {}, { message });
}

/**
 * Input type for EventBridge event normalization.
 */
type Input = Pick<PutEventsRequestEntry, "Detail" | "DetailType" | "Source">;

/**
 * Normalizes an EventBridge PutEvents request entry to a simplified event format.
 *
 * Converts the AWS SDK format (Detail, DetailType, Source) to the internal
 * event format (detail, detail-type, source).
 *
 * @param input - The EventBridge PutEvents request entry
 * @returns The normalized event object
 *
 * @example
 * ```typescript
 * const event = normalizeEventBridgetInput({
 *   Detail: '{"orderId": "123"}',
 *   DetailType: 'OrderCreated',
 *   Source: 'orders.service',
 * });
 * // Returns: { detail: '{"orderId": "123"}', 'detail-type': 'OrderCreated', source: 'orders.service' }
 * ```
 */
export function normalizeEventBridgetInput(input: Input): EventBridgeEvent {
  return {
    detail: input.Detail,
    "detail-type": input.DetailType,
    source: input.Source,
  };
}

/**
 * Extracts audit overrides from a batch processor result.
 *
 * Handles various result formats from batch record handlers:
 * - Objects with `_audit` property for explicit overrides
 * - Objects with `message` property for simple message extraction
 * - Non-objects or empty objects return empty overrides
 *
 * When both root message and audit override message exist, they are
 * concatenated with a space separator.
 *
 * @param message - The result from a batch record handler
 * @returns Partial audit input with extracted overrides
 *
 * @example
 * ```typescript
 * // With audit overrides
 * extractOverridesFromBatchProcessor({
 *   message: 'Processed',
 *   _audit: { status: 'success', tier: 3 }
 * });
 * // Returns: { status: 'success', tier: 3, message: 'Processed' }
 *
 * // With just message
 * extractOverridesFromBatchProcessor({ message: 'Done' });
 * // Returns: { message: 'Done' }
 *
 * // With non-object
 * extractOverridesFromBatchProcessor('success');
 * // Returns: {}
 * ```
 */
export function extractOverridesFromBatchProcessor(
  message: unknown | MessageWithAuditOverride,
): Partial<LogAuditInput> {
  if (message && typeof message === "object") {
    // Get the root message
    const rootMessage =
      "message" in message && typeof message.message === "string" ? message.message : undefined;

    // Is there an audit override?
    if ("_audit" in message) {
      const auditOverrides: Partial<LogAuditInput> =
        message._audit && typeof message._audit === "object" ? message._audit : {};

      return {
        ...auditOverrides,
        message: [rootMessage, auditOverrides?.message].filter(Boolean).join(" "),
      };
    }

    if (rootMessage) {
      return { message: rootMessage };
    }
  }

  return {};
}

/**
 * Normalizes an event source record body to an EventBridge event format.
 *
 * Currently only supports SQS event type. For unsupported event types,
 * returns undefined.
 *
 * @param eventType - The type of event source (SQS, Kinesis, DynamoDB)
 * @param record - The event source record
 * @returns The normalized EventBridge event, or undefined for unsupported types
 */
export function normalizeEventBridgetEventBody(
  eventType: keyof typeof EventType,
  record: EventSourceDataClassTypes,
): EventBridgeEvent | undefined {
  switch (eventType) {
    case EventType.SQS:
      return normalizeSQSEventBody(record as SQSRecord);
  }
}

/**
 * Extracts EventBridge event data from an SQS record body.
 *
 * Parses the SQS message body and extracts the EventBridge-specific
 * fields (detail, detail-type, source).
 *
 * @param record - The SQS record containing the message
 * @returns The extracted EventBridge event data
 */
export function normalizeSQSEventBody(record: SQSRecord): EventBridgeEvent | undefined {
  const bodyObject = JSON.parse(record.body);

  return {
    detail: bodyObject?.detail,
    "detail-type": bodyObject?.["detail-type"],
    source: bodyObject?.source,
  };
}

/**
 * Parses a trace ID into its component parts.
 *
 * Trace IDs follow the format "id:stage" where:
 * - id: The unique trace identifier
 * - stage: The processing stage number (defaults to 0 if not present)
 *
 * @param traceId - The trace ID string to parse
 * @returns An object with `id` and `stage` properties
 *
 * @example
 * ```typescript
 * getTraceParts("abc-123:5");
 * // Returns: { id: "abc-123", stage: 5 }
 *
 * getTraceParts("abc-123");
 * // Returns: { id: "abc-123", stage: 0 }
 * ```
 */
export function getTraceParts(traceId: string): { id: string; stage: number } {
  const [id, stage] = traceId.split(":");

  return {
    id,
    stage: Number(stage == null ? 0 : stage),
  };
}

/**
 * Extracts the unique record ID for audit correlation based on event type.
 *
 * Each event source has a stable unique identifier that persists across retries:
 * - SQS: `messageId` - unique per message, stable across retry deliveries
 * - Kinesis: `eventID` - unique per record in the stream
 * - DynamoDB Streams: `eventID` - unique per stream record
 *
 * @param eventType - The type of event source (SQS, KinesisDataStreams, DynamoDBStreams)
 * @param record - The event source record
 * @returns The unique record ID, or undefined for unsupported event types
 *
 * @example
 * ```typescript
 * // SQS record
 * const id = getRecordId("SQS", sqsRecord);
 * // Returns: sqsRecord.messageId
 *
 * // Kinesis record
 * const id = getRecordId("KinesisDataStreams", kinesisRecord);
 * // Returns: kinesisRecord.eventID
 * ```
 */
export function getRecordId(
  eventType: keyof typeof EventType,
  record: SQSRecord | KinesisStreamRecord | DynamoDBRecord,
): string | undefined {
  switch (eventType) {
    case EventType.SQS:
      return (record as SQSRecord).messageId;
    case EventType.KinesisDataStreams:
      return (record as KinesisStreamRecord).eventID;
    case EventType.DynamoDBStreams:
      return (record as DynamoDBRecord).eventID;
    default:
      return undefined;
  }
}

/**
 * Gets the approximate receive count from an SQS record.
 *
 * The receive count indicates how many times the message has been delivered:
 * - 1 = First delivery (not a retry)
 * - 2+ = Retry delivery
 *
 * @param record - The SQS record
 * @returns The receive count as a number
 *
 * @example
 * ```typescript
 * const count = getReceiveCount(sqsRecord);
 * if (count > 1) {
 *   console.log(`This is retry attempt ${count - 1}`);
 * }
 * ```
 */
export function getReceiveCount(record: SQSRecord): number {
  return Number(record.attributes.ApproximateReceiveCount);
}

/**
 * Checks if an SQS message is being retried.
 *
 * A message is considered a retry if it has been received more than once.
 *
 * @param record - The SQS record
 * @returns True if this is a retry delivery, false if first delivery
 *
 * @example
 * ```typescript
 * if (isRetry(sqsRecord)) {
 *   console.log("Processing retry...");
 * }
 * ```
 */
export function isRetry(record: SQSRecord): boolean {
  return getReceiveCount(record) > 1;
}
