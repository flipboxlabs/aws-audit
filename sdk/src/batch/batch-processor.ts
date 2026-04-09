import { BatchProcessor, type EventType } from "@aws-lambda-powertools/batch";
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
 *   })
 * );
 * ```
 */
export class AuditBatchProcessor<Record extends EventSourceDataClassTypes> extends BatchProcessor {
  /**
   * Creates a new AuditBatchProcessor instance.
   *
   * @param eventType - The type of event source (SQS, Kinesis, or DynamoDB)
   * @param audit - The Audits instance used to collect and publish audit logs
   * @param createAuditItem - Factory function that creates an audit log entry from a record
   */
  public constructor(
    eventType: keyof typeof EventType,
    readonly audit: Audits<AuditConfig>,
    readonly createAuditItem: (record: Record, overrides?: Partial<LogAuditInput>) => LogAuditInput,
  ) {
    super(eventType);
  }

  /**
   * Handles successful record processing by creating a success audit entry.
   *
   * Called automatically by the batch processor when a record is processed
   * without throwing an error. Creates an audit entry with SUCCESS status
   * and excludes the original event data to reduce storage costs.
   *
   * The audit ID is automatically set from the record's unique identifier
   * (messageId for SQS, eventID for Kinesis/DynamoDB) to enable retry correlation.
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

    // Auto-set ID for retry correlation using event record ID
    const recordId = getRecordId(
      this.eventType,
      record as SQSRecord | KinesisStreamRecord | DynamoDBRecord,
    );
    if (recordId && !auditItem.id) {
      auditItem.id = recordId;
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
   * the original event data for debugging, and captures the error details.
   *
   * The audit ID is automatically set from the record's unique identifier
   * (messageId for SQS, eventID for Kinesis/DynamoDB) to enable retry correlation.
   *
   * @param record - The record that failed processing
   * @param error - The error thrown during processing
   * @returns The failure response from the parent BatchProcessor
   */
  public failureHandler(record: Record, error: Error): FailureResponse {
    const auditItem = this.createAuditItem(record, {
      status: Status.FAIL,
      event: normalizeEventBridgetEventBody(this.eventType, record),
      message: error.message,
    });

    // Auto-set ID for retry correlation using event record ID
    const recordId = getRecordId(
      this.eventType,
      record as SQSRecord | KinesisStreamRecord | DynamoDBRecord,
    );
    if (recordId && !auditItem.id) {
      auditItem.id = recordId;
    }

    this.audit.addAudit({
      ...auditItem,
      error,
    });

    return super.failureHandler(record, error);
  }
}
