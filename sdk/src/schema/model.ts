import * as z from "zod/v4";

/**
 * Schema for EventBridge event data embedded in audit records.
 *
 * Captures the essential fields from an EventBridge event for replay
 * and debugging purposes. The detail field is automatically serialized
 * to a JSON string if provided as an object.
 *
 * @example
 * ```typescript
 * const event = EventBridgeEventSchema.parse({
 *   source: 'orders.service',
 *   'detail-type': 'OrderCreated',
 *   detail: { orderId: '123', amount: 99.99 },
 * });
 * // event.detail is now '{"orderId":"123","amount":99.99}'
 * ```
 */
export const EventBridgeEventSchema = z.object({
  /** The source service that generated the event */
  source: z.string().optional(),
  /** The type/category of the event */
  "detail-type": z.string().optional(),
  /** Event payload - objects are automatically JSON stringified */
  detail: z
    .union([z.string(), z.record(z.string(), z.any())])
    .optional()
    .pipe(z.transform((val) => (typeof val === "object" ? JSON.stringify(val) : val))),
});

/**
 * Inferred output type from EventBridgeEventSchema.
 * Note: detail is always a string after transformation.
 */
export type EventBridgeEvent = z.output<typeof EventBridgeEventSchema>;

/**
 * Schema for pagination parameters in list queries.
 *
 * Used to control page size and cursor-based pagination
 * for DynamoDB query operations.
 *
 * @example
 * ```typescript
 * const pagination = PaginationSchema.parse({
 *   pageSize: 25,
 *   nextToken: 'abc123...',
 * });
 * ```
 */
export const PaginationSchema = z.object({
  /** Number of items per page (string or number accepted) */
  pageSize: z.union([z.string(), z.number()]).nullable().optional(),
  /** Cursor token for fetching the next page */
  nextToken: z.string().nullable().optional(),
});

/**
 * Inferred output type from PaginationSchema.
 */
export type Pagination = z.output<typeof PaginationSchema>;

/**
 * Factory function to create a collection schema with a specific item type.
 *
 * @param itemSchema - Zod schema for the collection items
 * @returns A schema that validates an object with an `items` array
 *
 * @example
 * ```typescript
 * const UserCollectionSchema = CollectionSchema(UserSchema);
 * const result = UserCollectionSchema.parse({ items: [user1, user2] });
 * ```
 */
export const CollectionSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
  });

/**
 * Generic collection type containing an array of items.
 *
 * @typeParam I - The type of items in the collection
 */
export type Collection<I> = {
  items: I[];
};

/**
 * Factory function to create a paginated collection schema.
 *
 * Extends the basic collection with optional pagination metadata
 * for cursor-based pagination support.
 *
 * @param itemSchema - Zod schema for the collection items
 * @returns A schema that validates items array with optional pagination
 *
 * @example
 * ```typescript
 * const PaginatedAuditsSchema = PaginationCollectionSchema(AuditSchema);
 * const result = PaginatedAuditsSchema.parse({
 *   items: [audit1, audit2],
 *   pagination: { nextToken: 'xyz789' },
 * });
 * ```
 */
export const PaginationCollectionSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    pagination: PaginationSchema.optional(),
  });

/**
 * Generic paginated collection type.
 *
 * Extends Collection with optional pagination metadata for
 * cursor-based navigation through large result sets.
 *
 * @typeParam I - The type of items in the collection
 */
export type PaginationCollection<I> = Collection<I> & {
  pagination?: Pagination;
};
