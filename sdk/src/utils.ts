import { EventType } from "@aws-lambda-powertools/batch";
import type { EventSourceDataClassTypes } from "@aws-lambda-powertools/batch/types";
import type { PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import type { DynamoDBRecord, KinesisStreamRecord, SQSRecord } from "aws-lambda";
import KSUID from "ksuid";
import merge from "lodash.merge";
import type { MessageWithAuditOverride } from "./batch/batch-processor.js";
import { type LogAuditInput, Status } from "./schema/log.js";
import { type EventBridgeEvent, EventBridgeEventSchema } from "./schema/model.js";

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
 * Whether a resource has an id: anything but `undefined`, `null` or `""`. A numeric
 * id of `0` counts, which a truthiness check would drop.
 *
 * @internal
 */
export function hasResourceId(id: string | number | null | undefined): id is string | number {
  return id !== undefined && id !== null && id !== "";
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
  const match = /^(.*):(\d+)$/s.exec(traceId);

  return match
    ? `${match[1]}:${Number(match[2]) + 1}`
    : // No stage: it counts as 1
      `${traceId}:2`;
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
  // If a trace isn't set, try to set it from the sqs record's EventBridge event
  if (!audit.trace) {
    const trace = parseBody(sqsRecord.body)?.detail?.transaction?.trace;

    if (typeof trace === "string" && trace) {
      audit.trace = incrementTraceStage(trace);
    }
  }

  return buildAudit(audit, overrides);
}

/**
 * A message body as JSON, or undefined when it isn't JSON: a message needn't hold
 * an EventBridge event.
 *
 * @internal
 */
// oxlint-disable-next-line typescript/no-explicit-any -- any message body
function parseBody(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
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
type Input = Pick<PutEventsRequestEntry, "Detail" | "DetailType" | "Source" | "EventBusName">;

/**
 * Normalizes an EventBridge PutEvents request entry to a simplified event format.
 *
 * Converts the AWS SDK format (Detail, DetailType, Source, EventBusName) to the
 * internal event format (detail, detail-type, source, eventBusName). The bus is
 * kept so a rerun puts the event on it again; without one (or an empty one), a
 * rerun goes to the audit event bus.
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
 *   EventBusName: 'PROD-v1-Global',
 * });
 * // Returns: { detail: '{"orderId": "123"}', 'detail-type': 'OrderCreated',
 * //   source: 'orders.service', eventBusName: 'PROD-v1-Global' }
 * ```
 */
export function normalizeEventBridgetInput(input: Input): EventBridgeEvent {
  return {
    detail: input.Detail,
    "detail-type": input.DetailType,
    source: input.Source,
    // An empty name is none, as in process_batch_from_bus
    eventBusName: input.EventBusName || undefined,
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
 * @returns The extracted EventBridge event data, kept for debugging even when it
 *   can't be re-sent ({@link isResendable}), or undefined when the body isn't a JSON
 *   object, or its fields aren't an event's (as `sqs::event` reads it in Rust)
 */
export function normalizeSQSEventBody(record: SQSRecord): EventBridgeEvent | undefined {
  const bodyObject = parseBody(record.body);
  if (!isJsonObject(bodyObject)) return undefined;

  const event = {
    // A null detail is none
    detail: bodyObject.detail ?? undefined,
    "detail-type": bodyObject["detail-type"],
    source: bodyObject.source,
  };
  // The detail as the body holds it: the log schema stringifies an object one
  return EventBridgeEventSchema.safeParse(event).success ? (event as EventBridgeEvent) : undefined;
}

/** Whether a parsed JSON value is an object, not an array or null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An event as an audit records it, whose fields may be of any type when stored. */
type RecordedEvent = { source?: unknown; "detail-type"?: unknown; [field: string]: unknown };

/**
 * Whether an event can be put on a bus again: PutEvents needs its source, detail
 * type and a detail that's a JSON object, and refuses a source of AWS's own
 * (`aws.*`), such as an S3 event's.
 *
 * @param event - The recorded event
 * @returns Whether it has both
 */
export function isResendable(event: RecordedEvent | undefined): boolean {
  return (
    typeof event?.source === "string" &&
    event.source !== "" &&
    !event.source.startsWith("aws.") &&
    typeof event["detail-type"] === "string" &&
    event["detail-type"] !== "" &&
    isObjectDetail(event.detail)
  );
}

/** Whether a detail is a JSON object: as stored, a string holding one. */
function isObjectDetail(detail: unknown): boolean {
  if (typeof detail !== "string") return isJsonObject(detail);
  try {
    return isJsonObject(JSON.parse(detail));
  } catch {
    return false;
  }
}

/**
 * Whether an audit's event can be rerun (`is_rerunable` in the Rust crate): it
 * recorded a resendable event, and either says it's rerunable or, without the
 * flag, failed. A retry that succeeded keeps the event its failure recorded, so an
 * unset flag counts only for a failure.
 *
 * @param audit - The audit's flag, status and event
 * @returns Whether a rerun sends its event
 */
export function isRerunable(audit: RerunableFields): boolean {
  return isResendable(audit.event) && (audit.rerunable ?? audit.status === Status.FAIL);
}

/**
 * The flag an upsert stores (`rerunable_to_store` in the Rust crate), from what it
 * logged alone:
 *
 * - with an event, {@link isRerunable} for it;
 * - without one, the flag it gives, as a rerun still needs the event the audit
 *   kept; or, without a flag, `false` unless it failed;
 * - undefined for a failure logged without an event or a flag, which leaves the
 *   stored flag: an earlier opt-out stays, and so does an earlier failure's
 *   rerunable event.
 *
 * @param audit - The upserted audit's flag, status and event
 * @returns The flag to store, or undefined to leave the stored one
 */
export function rerunableToStore(audit: RerunableFields): boolean | undefined {
  if (audit.event !== undefined) return isRerunable(audit);
  if (audit.rerunable != null) return audit.rerunable;
  return audit.status === Status.FAIL ? undefined : false;
}

/** What decides whether an audit's event can be rerun. */
type RerunableFields = {
  rerunable?: boolean | null;
  status?: string;
  event?: RecordedEvent;
};

/**
 * Parses a trace ID into its component parts.
 *
 * Trace IDs follow the format "id:stage" where:
 * - id: The unique trace identifier, which may itself contain colons
 * - stage: The processing stage number, a non-negative integer after the last colon
 *   (0 when there is none)
 *
 * A suffix that isn't a stage number is part of the id: "batch:a" is the id
 * "batch:a" at stage 0. DynamoDB rejects a NaN stage, which splitting on the first
 * colon used to produce.
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
  const match = /^(.*):(\d+)$/s.exec(traceId);

  return match ? { id: match[1], stage: Number(match[2]) } : { id: traceId, stage: 0 };
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
