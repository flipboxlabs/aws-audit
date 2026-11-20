import { BatchProcessor, EventType } from "@aws-lambda-powertools/batch";
import type {
  EventSourceDataClassTypes,
  FailureResponse,
  SuccessResponse,
} from "@aws-lambda-powertools/batch/types";
import type { DynamoDBRecord, KinesisStreamRecord, SQSRecord } from "aws-lambda";
import type { Audits } from "../audits.js";
import type { AuditConfig } from "../config.js";
import { type LogAuditInput, Status } from "../schema/log.js";
import {
  extractOverridesFromBatchProcessor,
  getRecordId,
  getRerunAuditId,
  normalizeEventBridgetEventBody,
} from "../utils.js";

/**
 * Result type that can include optional audit overrides.
 * When a batch processor handler returns this type, the _audit field
 * can be used to customize the audit log entry.
 */
export type MessageWithAuditOverride = {
  /** Human-readable message describing the result */
  message: string;
  /** Optional overrides to apply to the audit log entry */
  _audit?: Partial<LogAuditInput>;
};

/**
 * Options for an {@link AuditBatchProcessor}.
 */
export type AuditBatchProcessorOptions = {
  /**
   * The event bus, by name or ARN, whose rule sends the records. It's recorded
   * with a failed record's event, so a rerun puts the event on that bus again;
   * without it, a rerun goes to the audit event bus. A bus in another account
   * than the audit stack's must be given by ARN.
   */
  eventBusName?: string;
};

/**
 * Extended batch processor that automatically creates audit log entries
 * for each record processed in a batch operation.
 *
 * Integrates with AWS Lambda Powertools BatchProcessor to provide
 * automatic audit logging for SQS, Kinesis, and DynamoDB Streams events.
 *
 * @template Record - The type of event source record being processed
 *
 * @example
 * ```typescript
 * const processor = new AuditBatchProcessor(
 *   EventType.SQS,
 *   audits,
 *   (record, overrides) => ({
 *     operation: 'processMessage',
 *     target: { app: 'MyApp', type: 'Message' },
 *     ...overrides,
 *   }),
 *   { eventBusName: 'PROD-Global' },
 * );
 * ```
 */
export class AuditBatchProcessor<Record extends EventSourceDataClassTypes> extends BatchProcessor {
  /** The bus recorded with a failed record's event (see {@link AuditBatchProcessorOptions}) */
  readonly eventBusName?: string;

  /**
   * Creates a new AuditBatchProcessor instance.
   *
   * @param eventType - The type of event source (SQS, Kinesis, or DynamoDB)
   * @param audit - The Audits instance used to collect and publish audit logs
   * @param createAuditItem - Factory function that creates an audit log entry from a record
   * @param options - The event bus a rerun of a failed record goes to
   */
  public constructor(
    eventType: keyof typeof EventType,
    readonly audit: Audits<AuditConfig>,
    readonly createAuditItem: (record: Record, overrides?: Partial<LogAuditInput>) => LogAuditInput,
    { eventBusName }: AuditBatchProcessorOptions = {},
  ) {
    super(eventType);
    this.eventBusName = eventBusName;
  }

  /**
   * Handles successful record processing by creating a success audit entry.
   *
   * Called automatically by the batch processor when a record is processed
   * without throwing an error. Creates an audit entry with SUCCESS status
   * and excludes the original event data to reduce storage costs.
   *
   * Without an ID of its own, the audit takes one by {@link AuditBatchProcessor.correlate}.
   *
   * @param record - The successfully processed record
   * @param result - The result returned by the record handler, may include audit overrides
   * @returns The success response from the parent BatchProcessor
   */
  public successHandler(
    record: Record,
    result: unknown | MessageWithAuditOverride,
  ): SuccessResponse {
    const auditItem = this.createAuditItem(record, {
      status: Status.SUCCESS,
      ...extractOverridesFromBatchProcessor(result),
    });

    if (!auditItem.id) {
      Object.assign(auditItem, this.correlate(record, auditItem));
    }

    this.audit.addAudit({
      ...auditItem,
      event: undefined, // Don't store event when successful
    });

    return super.successHandler(record, result);
  }

  /**
   * Handles failed record processing by creating a failure audit entry.
   *
   * Called automatically by the batch processor when a record handler
   * throws an error. Creates an audit entry with FAIL status, includes
   * the original event data for debugging and rerunning, with the configured
   * event bus, and captures the error details.
   *
   * Without an ID of its own, the audit takes one by {@link AuditBatchProcessor.correlate}.
   *
   * @param record - The record that failed processing
   * @param error - The error thrown during processing
   * @returns The failure response from the parent BatchProcessor
   */
  public failureHandler(record: Record, error: Error): FailureResponse {
    const event = normalizeEventBridgetEventBody(this.eventType, record);
    const { eventBusName } = this;
    const auditItem = this.createAuditItem(record, {
      status: Status.FAIL,
      event: event && eventBusName ? { ...event, eventBusName } : event,
      message: error.message,
    });

    if (!auditItem.id) {
      Object.assign(auditItem, this.correlate(record, auditItem));
    }

    this.audit.addAudit({
      ...auditItem,
      error,
    });

    return super.failureHandler(record, error);
  }

  /**
   * The ID an audit of a record takes when it has none: the record's unique
   * identifier (messageId for SQS, eventID for Kinesis/DynamoDB), so retries of the
   * record are attempts of one audit. When an SQS message's event reruns an audit
   * this one matches ({@link getRerunAuditId}), that audit's ID instead, with
   * `rerun: true`, so the rerun's outcome is an attempt of it tagged `rerun`.
   *
   * @param record - The record processed
   * @param auditItem - Its audit
   * @returns The ID, undefined for an unsupported event type, and the rerun tag
   */
  protected correlate(
    record: Record,
    auditItem: LogAuditInput,
  ): Pick<LogAuditInput, "id" | "rerun"> {
    const rerunId =
      this.eventType === EventType.SQS
        ? getRerunAuditId(record as SQSRecord, auditItem)
        : undefined;
    if (rerunId) return { id: rerunId, rerun: true };

    const recordId = getRecordId(
      this.eventType,
      record as SQSRecord | KinesisStreamRecord | DynamoDBRecord,
    );
    return recordId ? { id: recordId } : {};
  }
}
