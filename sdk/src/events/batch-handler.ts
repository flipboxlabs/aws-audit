import type { Logger } from "@aws-lambda-powertools/logger";
import {
  type EventBridgeClient,
  PutEventsCommand,
  type PutEventsCommandOutput,
  type PutEventsRequestEntry,
  type PutEventsResultEntry,
} from "@aws-sdk/client-eventbridge";

/**
 * Default batch size for EventBridge PutEvents API calls.
 * EventBridge allows a maximum of 10 entries per PutEvents call.
 */
const CHUNK_SIZE = 10;

/**
 * Default number of PutEvents attempts made by {@link BatchHandler.putEventsWithRetry},
 * including the first.
 */
const RETRY_ATTEMPTS = 3;

/**
 * Default delay in milliseconds before the first retry in
 * {@link BatchHandler.putEventsWithRetry}. It doubles on each later retry.
 */
const RETRY_BASE_DELAY = 100;

/**
 * Longest delay in milliseconds before a retry in {@link BatchHandler.putEventsWithRetry}.
 */
const RETRY_MAX_DELAY = 30_000;

/**
 * Result entry error codes worth resending the entry for.
 *
 * EventBridge documents `InternalFailure` and `ThrottlingException` as the
 * retryable PutEvents entry errors; `InternalException` and
 * `ServiceUnavailable` are its other transient service errors. Every other
 * code (`MalformedDetail`, `InvalidArgument`, `AccessDeniedException`, ...)
 * fails the same way when resent.
 *
 * @internal
 */
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "InternalException",
  "InternalFailure",
  "ServiceUnavailable",
  "ThrottlingException",
]);

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
 * Options for {@link BatchHandler.putEventsWithRetry}.
 */
export interface PutEventsRetryOptions {
  /** Batch size for chunking, an integer from 1 to 10 (default: 10) */
  chunk?: number;
  /** Total PutEvents attempts per entry, including the first, an integer of at least 1 (default: 3) */
  attempts?: number;
  /**
   * Delay in milliseconds before the first retry, a finite number of at least 0
   * (default: 100). It doubles on each later retry up to 30 seconds, and each
   * delay is jittered to between half and all of it.
   */
  baseDelay?: number;
}

/**
 * Options for {@link PutEventsError}.
 */
export interface PutEventsErrorOptions extends ErrorOptions {
  /** Result entries EventBridge returned, accepted and rejected, in request order */
  results?: PutEventsResultEntry[];
}

/**
 * Thrown by {@link BatchHandler.putEventsOrThrow} and
 * {@link BatchHandler.putEventsWithRetry} when EventBridge did not accept
 * every entry.
 *
 * Either a PutEvents call itself failed (the client error is the `cause`),
 * or EventBridge answered but did not accept every entry (`failedEntries`
 * holds the result entries carrying an `ErrorCode`). With
 * {@link BatchHandler.putEventsWithRetry} both can be true, since it keeps
 * sending the other chunks after one throws.
 */
export class PutEventsError extends Error {
  /**
   * Result entries EventBridge returned, accepted and rejected, in request
   * order. Entries without one (their call threw, or EventBridge sent none
   * back) are left out. {@link BatchHandler.putEventsOrThrow} leaves it empty
   * when a call threw.
   */
  public readonly results: PutEventsResultEntry[];

  /**
   * @param message - Description of the failure
   * @param failedEntries - Result entries EventBridge rejected (empty when the call threw)
   * @param options - Error options; `cause` is the client error when a call threw,
   *   and `results` the result entries EventBridge returned
   */
  public constructor(
    message: string,
    public readonly failedEntries: PutEventsResultEntry[] = [],
    { results = [], ...options }: PutEventsErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PutEventsError";
    this.results = results;
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
   * A `chunk` that isn't an integer from 1 to 10 is a failure too: nothing is sent.
   *
   * @param entries - Array of EventBridge event entries to publish
   * @param chunk - Batch size for chunking, an integer from 1 to 10 (default: 10)
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
      assertChunkSize(chunk);

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
        { results: result },
      );
    }

    this.logger.debug("Pushed event bridge events", {
      events: result,
    });

    return result;
  }

  /**
   * Publishes events to EventBridge like {@link putEventsOrThrow}, retrying
   * entries EventBridge rejected for a transient reason before giving up.
   *
   * Only rejected entries whose `ErrorCode` is retryable (throttling or an
   * internal failure) are resent, after a jittered exponential backoff, until
   * they are accepted or `attempts` run out. Result entries line up with
   * request entries by position, which is how the rejected ones are picked.
   *
   * Nothing that might already have been published is resent, since PutEvents
   * isn't idempotent:
   * - A PutEvents call that throws (after the EventBridge client's own
   *   retries) fails its whole chunk; the other chunks are still sent.
   * - An entry EventBridge returned no result entry for fails.
   * - An entry rejected with any other `ErrorCode` fails without a retry.
   *
   * @param entries - Array of EventBridge event entries to publish
   * @param options - Batch size, attempts and backoff delay
   * @returns Array of result entries from EventBridge, all accepted, in `entries` order
   * @throws {RangeError} When `chunk` isn't an integer from 1 to 10, `attempts`
   *   isn't an integer of at least 1, or `baseDelay` isn't a finite number of at
   *   least 0 (nothing is sent)
   * @throws {PutEventsError} When any entry is not accepted once retries are
   *   done. `failedEntries` holds the final rejected result entries, `results`
   *   every result entry returned, and `cause` the last client error if a call threw.
   *
   * @example
   * ```typescript
   * try {
   *   await handler.putEventsWithRetry(events, { attempts: 5 });
   * } catch (error) {
   *   if (error instanceof PutEventsError) {
   *     logger.critical("Events not sent", error);
   *   }
   * }
   * ```
   */
  public async putEventsWithRetry(
    entries: PutEventsRequestEntry[],
    {
      chunk = CHUNK_SIZE,
      attempts = RETRY_ATTEMPTS,
      baseDelay = RETRY_BASE_DELAY,
    }: PutEventsRetryOptions = {},
  ): Promise<PutEventsResultEntry[]> {
    assertChunkSize(chunk);

    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError(`attempts must be an integer of at least 1, got ${attempts}`);
    }

    if (!Number.isFinite(baseDelay) || baseDelay < 0) {
      throw new RangeError(`baseDelay must be a finite number of at least 0, got ${baseDelay}`);
    }

    // The latest result entry for each position in `entries`
    const results: PutEventsResultEntry[] = [];

    // Positions in `entries` to send on this attempt
    let pending = entries.map((_, index) => index);
    let cause: unknown;
    let attempt = 1;

    for (; ; attempt++) {
      const retry: number[] = [];

      for (let i = 0, j = pending.length; i < j; i += chunk) {
        const indexes = pending.slice(i, i + chunk);

        let output: PutEventsCommandOutput;

        try {
          output = await this.client.send(
            new PutEventsCommand({
              Entries: indexes.map((index) => entries[index]),
            }),
          );
        } catch (error) {
          // The call may have been published before it failed (a timeout, say),
          // so the chunk fails without a resend.
          cause = error;
          continue;
        }

        indexes.forEach((index, position) => {
          const entry = output.Entries?.[position];

          // No result entry: it may have been accepted, so it isn't resent
          if (!entry) {
            return;
          }

          results[index] = entry;

          if (entry.ErrorCode && RETRYABLE_ERROR_CODES.has(entry.ErrorCode)) {
            retry.push(index);
          }
        });
      }

      if (retry.length === 0 || attempt >= attempts) {
        break;
      }

      // Jittered exponential backoff: between half and all of baseDelay * 2^(attempt - 1), capped
      const ceiling = Math.min(baseDelay * 2 ** (attempt - 1), RETRY_MAX_DELAY);
      const delayMs = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);

      this.logger.warn("Retrying event bridge events", {
        count: retry.length,
        attempt,
        delayMs,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      pending = retry;
    }

    // Drop the positions that have no result entry
    const returned = results.filter((entry) => entry !== undefined);
    const failedEntries = returned.filter((entry) => entry.ErrorCode);
    const accepted = returned.length - failedEntries.length;

    if (accepted !== entries.length) {
      throw new PutEventsError(
        `EventBridge accepted ${accepted} of ${entries.length} events after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}`,
        failedEntries,
        cause === undefined ? { results: returned } : { cause, results: returned },
      );
    }

    this.logger.debug("Pushed event bridge events", {
      events: returned,
    });

    return returned;
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
