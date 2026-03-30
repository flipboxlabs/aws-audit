import * as z from "zod/v4";
import { generateAuditId } from "../utils.js";
import { BaseSchema, DateTimeStringSchema } from "./common.js";

/**
 * Schema for audit records being written to DynamoDB storage.
 *
 * Extends BaseSchema with storage-specific fields and transformations:
 * - `id`: Auto-generated KSUID if not provided
 * - `updatedAt`: Defaults to current time, normalized to ISO string
 * - `createdAt`: Defaults to current time, normalized to ISO string
 *
 * This schema handles the conversion between application types (Date)
 * and storage types (ISO string) for DynamoDB compatibility.
 *
 * @example
 * ```typescript
 * // With auto-generated values
 * const storage = AuditStorageSchema.parse({
 *   operation: 'createUser',
 *   status: 'success',
 *   target: { app: 'MyApp', type: 'User', id: 'user-123' },
 *   tier: 2,
 * });
 * // storage.id is auto-generated KSUID
 * // storage.updatedAt is current time as ISO string
 * // storage.createdAt is current time as ISO string
 * ```
 *
 * @example
 * ```typescript
 * // With explicit Date objects
 * const storage = AuditStorageSchema.parse({
 *   id: 'custom-id',
 *   operation: 'updateUser',
 *   status: 'success',
 *   target: { app: 'MyApp', type: 'User', id: 'user-123' },
 *   tier: 2,
 *   updatedAt: new Date(),
 *   createdAt: new Date('2024-01-01'),
 * });
 * // Dates are converted to ISO strings
 * ```
 */
export const AuditStorageSchema = z.object({
	...BaseSchema.shape,
	/**
	 * Unique audit identifier.
	 * Auto-generates a KSUID if not provided.
	 */
	id: z.string().default(generateAuditId()),
	/**
	 * Last update timestamp.
	 * Accepts ISO string or Date, outputs ISO string.
	 * Defaults to current time.
	 */
	updatedAt: DateTimeStringSchema.default(() => new Date().toISOString()),
	/**
	 * Creation timestamp.
	 * Accepts ISO string or Date, outputs ISO string.
	 * Defaults to current time.
	 */
	createdAt: DateTimeStringSchema.default(() => new Date().toISOString()),
});

/**
 * Input type for AuditStorageSchema.
 *
 * Accepts Date objects or ISO strings for timestamps.
 * ID is optional (auto-generated if not provided).
 */
export type AuditStorageInput = z.input<typeof AuditStorageSchema>;

/**
 * Output type from AuditStorageSchema.
 *
 * All timestamps are ISO strings, ID is always present.
 * Ready for DynamoDB storage.
 */
export type AuditStorage = z.output<typeof AuditStorageSchema>;
