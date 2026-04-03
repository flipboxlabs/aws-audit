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
