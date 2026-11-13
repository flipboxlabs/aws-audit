import type { Logger } from "@aws-lambda-powertools/logger";
import {
  type EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
  type PutEventsResultEntry,
} from "@aws-sdk/client-eventbridge";

/**
 * Default batch size for EventBridge PutEvents API calls.
 * EventBridge allows a maximum of 10 entries per PutEvents call.
 */
const CHUNK_SIZE = 10;

/**
 * Throws when `chunk` isn't a batch size EventBridge accepts (1 to 10).
 *
 * @internal
 */
const assertChunkSize = (chunk: number): void => {
  if (!Number.isInteger(chunk) || chunk < 1 || chunk > CHUNK_SIZE) {
    throw new RangeError(`chunk must be an integer from 1 to ${CHUNK_SIZE}, got ${chunk}`);
  }
};

/**
 * Thrown by {@link BatchHandler.putEventsOrThrow} when EventBridge did not
 * accept every entry.
 *
 * Either the PutEvents call itself failed (the client error is the `cause`
 * and `failedEntries` is empty), or EventBridge answered but did not accept
 * every entry (`failedEntries` holds the result entries carrying an
 * `ErrorCode`).
 */
export class PutEventsError extends Error {
  /**
   * @param message - Description of the failure
   * @param failedEntries - Result entries EventBridge rejected (empty when the call threw)
   * @param options - Error options; `cause` is the client error when the call threw
   */
  public constructor(
    message: string,
    public readonly failedEntries: PutEventsResultEntry[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PutEventsError";
  }
}

/**
 * Handles batched EventBridge event publishing with automatic chunking.
 *
 * Provides a wrapper around the EventBridge PutEvents API that automatically
 * splits large event arrays into compliant batch sizes and handles errors gracefully.
 *
 * @example
 * ```typescript
 * const handler = new BatchHandler(logger, eventBridgeClient);
 *
 * const results = await handler.putEvents([
 *   { DetailType: 'OrderCreated', Detail: '{"orderId":"123"}', Source: 'orders' },
 *   { DetailType: 'OrderCreated', Detail: '{"orderId":"456"}', Source: 'orders' },
 * ]);
 * ```
 */
export class BatchHandler {
  /**
   * Creates a new BatchHandler instance.
   *
   * @param logger - Logger instance for debug and error logging
   * @param client - EventBridge client for API calls
   */
  public constructor(
    private readonly logger: Logger,
    private readonly client: EventBridgeClient,
  ) {}

  /**
   * Publishes events to EventBridge with automatic batching and error handling.
   *
   * Events are automatically chunked into batches of the specified size
   * (default 10, the EventBridge maximum). On success, logs the results
   * at debug level. On failure, logs at critical level and returns an empty array.
   * Entries EventBridge rejected come back in the results (with an `ErrorCode`)
   * rather than throwing; use {@link putEventsOrThrow} to fail on either.
   *
   * @param entries - Array of EventBridge event entries to publish
   * @param chunk - Batch size for chunking (default: 10)
   * @returns Array of result entries from EventBridge, or empty array on error
   *
   * @example
   * ```typescript
   * const results = await handler.putEvents(events);
   * console.log(`Published ${results.length} events`);
   * ```
   */
  public async putEvents(
    entries: PutEventsRequestEntry[],
    chunk: number = CHUNK_SIZE,
  ): Promise<PutEventsResultEntry[]> {
    try {
      const result = await this.sendEventsViaBatch(this.client, entries, chunk);

      this.logger.debug("Pushed event bridge events", {
        events: result,
      });

      return result;
    } catch (error) {
      this.logger.critical("Error pushing event bridge events", error as Error);
    }

    return [];
  }

  /**
   * Publishes events to EventBridge like {@link putEvents}, but throws when
   * any entry was not accepted instead of swallowing the failure.
   *
   * Use it when the caller must know whether the events were sent.
   * {@link putEvents} keeps its never-throw behavior.
   *
   * @param entries - Array of EventBridge event entries to publish
   * @param chunk - Batch size for chunking, an integer from 1 to 10 (default: 10)
   * @returns Array of result entries from EventBridge, all accepted
   * @throws {RangeError} When `chunk` isn't an integer from 1 to 10 (nothing is sent)
   * @throws {PutEventsError} When a PutEvents call throws (the client error is
   *   the `cause`), or EventBridge accepts fewer entries than were sent (the
   *   result entries carrying an `ErrorCode` are in `failedEntries`)
   *
   * @example
   * ```typescript
   * try {
   *   await handler.putEventsOrThrow(events);
   * } catch (error) {
   *   if (error instanceof PutEventsError) {
   *     logger.error("Events not sent", error);
   *   }
   *   throw error;
   * }
   * ```
   */
  public async putEventsOrThrow(
    entries: PutEventsRequestEntry[],
    chunk: number = CHUNK_SIZE,
  ): Promise<PutEventsResultEntry[]> {
    assertChunkSize(chunk);

    let result: PutEventsResultEntry[];

    try {
      result = await this.sendEventsViaBatch(this.client, entries, chunk);
    } catch (error) {
      throw new PutEventsError("Error pushing event bridge events", [], { cause: error });
    }

    // EventBridge answers one result entry per request entry; a rejected one
    // carries an ErrorCode (and counts toward FailedEntryCount).
    const failedEntries = result.filter((entry) => entry.ErrorCode);
    const accepted = result.length - failedEntries.length;

    if (accepted !== entries.length) {
      throw new PutEventsError(
        `EventBridge accepted ${accepted} of ${entries.length} events`,
        failedEntries,
      );
    }

    this.logger.debug("Pushed event bridge events", {
      events: result,
    });

    return result;
  }

  /**
   * Sends events to EventBridge in batches.
   *
   * Iterates through the entries array in chunks, sending each batch
   * via the PutEvents API and collecting the results.
   *
   * @param client - EventBridge client for API calls
   * @param entries - Array of event entries to send
   * @param chunk - Number of entries per batch
   * @returns Combined array of result entries from all batches
   *
   * @internal
   */
  private async sendEventsViaBatch(
    client: EventBridgeClient,
    entries: PutEventsRequestEntry[],
    chunk: number = CHUNK_SIZE,
  ): Promise<PutEventsResultEntry[]> {
    const result: PutEventsResultEntry[] = [];

    // Chunk into batches
    for (let i = 0, j = entries.length; i < j; i += chunk) {
      const output = await client.send(
        new PutEventsCommand({
          Entries: entries.slice(i, i + chunk),
        }),
      );

      if (output.Entries) {
        result.push(...output.Entries);
      }
    }

    return result;
  }
}
