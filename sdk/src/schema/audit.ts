import * as z from "zod/v4";
import { BaseSchema, DateTimeObjectSchema } from "./common.js";

/**
 * Schema for fully-hydrated audit records retrieved from storage.
 *
 * Extends BaseSchema with timestamp fields that are transformed
 * from ISO strings to Date objects for easier manipulation.
 *
 * This schema is used when reading audit records from DynamoDB,
 * where timestamps are stored as ISO 8601 strings.
 *
 * @example
 * ```typescript
 * const audit = AuditSchema.parse({
 *   id: 'audit-123',
 *   operation: 'createUser',
 *   status: 'success',
 *   target: { app: 'MyApp', type: 'User', id: 'user-456' },
 *   tier: 2,
 *   updatedAt: '2024-01-15T10:30:00.000Z',
 *   createdAt: '2024-01-15T10:30:00.000Z',
 * });
 *
 * // audit.updatedAt is now a Date object
 * console.log(audit.updatedAt?.toISOString());
 * ```
 */
export const AuditSchema = z.object({
  ...BaseSchema.shape,
  /** Last update timestamp - ISO string transformed to Date */
  updatedAt: DateTimeObjectSchema,
  /** Creation timestamp - ISO string transformed to Date */
  createdAt: DateTimeObjectSchema,
});

/**
 * Input type for AuditSchema.
 *
 * Accepts ISO 8601 datetime strings for timestamps.
 */
export type AuditInput = z.input<typeof AuditSchema>;

/**
 * Output type from AuditSchema.
 *
 * Timestamps are Date objects (or undefined).
 */
export type Audit = z.output<typeof AuditSchema>;

/**
 * Schema for audit payloads in API responses.
 *
 * Uses the base schema without timestamp transformation,
 * suitable for JSON serialization in API responses.
 */
export const AuditPayloadSchema = BaseSchema;

/**
 * Output type for audit payloads.
 */
export type AuditPayload = z.output<typeof AuditPayloadSchema>;

/**
 * Schema for audit list item payloads.
 *
 * Same as AuditPayloadSchema, used for items in list responses
 * where a lighter payload is sufficient.
 */
export const AuditListItemPayloadSchema = BaseSchema;

/**
 * Output type for audit list item payloads.
 */
export type AuditAuditListItemPayload = z.output<typeof AuditListItemPayloadSchema>;
