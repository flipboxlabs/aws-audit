import type { Logger } from "@aws-lambda-powertools/logger";
import {
  EventBridgeClient,
  type PutEventsRequestEntry,
  type PutEventsResultEntry,
} from "@aws-sdk/client-eventbridge";
import { EventBridge } from "../constants.js";
import type { UpsertAudit } from "../schema/service.js";
import { BatchHandler } from "./batch-handler.js";

/**
 * Event detail payload structure for audit events.
 *
 * Wraps the audit data in a consistent structure for EventBridge events.
 */
export interface AuditEventDetail {
  /** The audit record being published */
  audit: UpsertAudit;
}

/**
 * Publishes audit events to AWS EventBridge.
 *
 * Provides a high-level interface for publishing audit-related events
 * to EventBridge, with automatic event formatting and batching.
 *
 * Events are published to the configured audit event bus with the
 * appropriate source and detail type for downstream consumers.
 *
 * @example
 * ```typescript
 * const eventBus = new AuditEventBus(logger);
 *
 * // Publish audit upsert events
 * await eventBus.upserted([
 *   { id: 'audit-1', operation: 'createUser', ... },
 *   { id: 'audit-2', operation: 'updateUser', ... },
 * ]);
 * ```
 */
export class AuditEventBus {
  /**
   * Creates a new AuditEventBus instance.
   *
   * @param logger - Logger instance for the underlying BatchHandler
   * @param handler - BatchHandler for EventBridge operations (defaults to new instance with EventBridgeClient)
   */
  constructor(
    logger: Logger,
    protected readonly handler: BatchHandler = new BatchHandler(
      logger,
      new EventBridgeClient({
        region: process.env.AWS_REGION,
        logger,
      }),
    ),
  ) {}

  /**
   * Serializes an audit record into an EventBridge detail string.
   *
   * Wraps the audit in an AuditEventDetail structure and converts to JSON.
   *
   * @param audit - The audit record to serialize
   * @returns JSON string containing the event detail
   *
   * @internal
   */
  protected createDetail(audit: UpsertAudit): string {
    const props: AuditEventDetail = {
      audit,
    };

    return JSON.stringify(props);
  }

  /**
   * Publishes audit "upserted" events to EventBridge.
   *
   * Creates EventBridge events for each audit item with:
   * - EventBusName: Configured audit event bus
   * - DetailType: "Upserted" event type
   * - Source: Configured audit source
   * - Detail: JSON-serialized audit data
   *
   * Additional events can be included via the extraEvents parameter.
   *
   * @param items - Array of audit records to publish as upserted events
   * @param extraEvents - Optional additional EventBridge events to include in the batch
   * @returns Array of result entries from EventBridge
   *
   * @example
   * ```typescript
   * // Publish audit events with additional custom events
   * const results = await eventBus.upserted(audits, [
   *   { DetailType: 'CustomEvent', Detail: '{}', Source: 'custom' },
   * ]);
   * ```
   */
  public async upserted(
    items: Array<UpsertAudit>,
    extraEvents?: PutEventsRequestEntry[],
  ): Promise<PutEventsResultEntry[]> {
    const events = items.map((audit) => ({
      EventBusName: EventBridge.Bus.Name(),
      Detail: this.createDetail(audit),
      DetailType: EventBridge.DetailType.UPSERTED,
      Source: EventBridge.Source,
    }));

    return await this.handler.putEvents([...events, ...(extraEvents || [])]);
  }
}
