import type { Logger } from "@aws-lambda-powertools/logger";
import {
  EventBridgeClient,
  type PutEventsRequestEntry,
  type PutEventsResultEntry,
} from "@aws-sdk/client-eventbridge";
import { EventBridge } from "../constants.js";
import type { UpsertAudit } from "../schema/service.js";
import { BatchHandler, PutEventsError } from "./batch-handler.js";

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
   * @param logger - Logger instance for failed publishes and the underlying BatchHandler
   * @param handler - BatchHandler for EventBridge operations (defaults to new instance with EventBridgeClient)
   */
  constructor(
    protected readonly logger: Logger,
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
   * Events are sent like {@link upsertedOrThrow}, so throttled entries and
   * internal failures are retried, but this never throws: when an event still
   * isn't accepted it logs at critical level and returns what EventBridge
   * answered, as {@link BatchHandler.putEvents} does.
   *
   * @param items - Array of audit records to publish as upserted events
   * @param extraEvents - Optional additional EventBridge events to include in the batch
   * @returns Array of result entries from EventBridge (rejected ones carry an
   *   `ErrorCode`), or an empty array when a PutEvents call threw
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
    try {
      return await this.upsertedOrThrow(items, extraEvents);
    } catch (error) {
      this.logger.critical("Error pushing event bridge events", error as Error);

      return error instanceof PutEventsError && error.cause === undefined ? error.results : [];
    }
  }

  /**
   * Publishes audit "upserted" events to EventBridge like {@link upserted},
   * but throws when any event is not accepted instead of logging it.
   *
   * Events, extra events included, are sent with
   * {@link BatchHandler.putEventsWithRetry} and its defaults: entries rejected
   * for throttling or an internal failure are retried (3 attempts in total,
   * with jittered backoff); other rejections, entries without a result entry,
   * and PutEvents calls that throw fail without a resend.
   *
   * @param items - Array of audit records to publish as upserted events
   * @param extraEvents - Optional additional EventBridge events to include in the batch
   * @returns Array of result entries from EventBridge, all accepted, in request order
   *   (audit events first, then extra events)
   * @throws {PutEventsError} When any event is not accepted once retries are done
   *
   * @example
   * ```typescript
   * try {
   *   await eventBus.upsertedOrThrow(audits);
   * } catch (error) {
   *   if (error instanceof PutEventsError) {
   *     logger.critical("Upserted events not published", { failedEntries: error.failedEntries });
   *   }
   * }
   * ```
   */
  public async upsertedOrThrow(
    items: Array<UpsertAudit>,
    extraEvents?: PutEventsRequestEntry[],
  ): Promise<PutEventsResultEntry[]> {
    const events = items.map((audit) => ({
      EventBusName: EventBridge.Bus.Name(),
      Detail: this.createDetail(audit),
      DetailType: EventBridge.DetailType.UPSERTED,
      Source: EventBridge.Source,
    }));

    return await this.handler.putEventsWithRetry([...events, ...(extraEvents || [])]);
  }
}
