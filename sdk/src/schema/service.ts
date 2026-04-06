import * as z from "zod/v4";
import { AttemptSchema, DateTimeStringSchema } from "./common.js";
import { _BaseLogAuditSchema, createTypedLogAuditSchema } from "./log.js";

/**
 * Schema for audit upsert operations via the AuditService.
 *
 * Extends _BaseLogAuditSchema with additional fields for service-layer operations:
 * - `id`: Optional identifier (auto-generated if not provided)
 * - `rerunable`: Flag indicating if the audit's operation can be retried
 * - `attempts`: History of execution attempts for retry tracking
 * - `createdAt`: Original creation timestamp (preserved on retries)
 *
 * This schema is used by {@link AuditService.upsertItem} for validating
 * audit entries before storage and event emission.
 *
 * @example
 * ```typescript
 * const audit = UpsertAuditSchema.parse({
 *   operation: 'processPayment',
 *   target: { app: 'Payments', type: 'Payment', id: 'pay-123' },
 *   status: 'success',
 *   rerunable: true,
 *   event: {
 *     source: 'payments.service',
 *     'detail-type': 'PaymentRequested',
 *     detail: { amount: 99.99 },
 *   },
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With explicit ID for idempotent upserts
 * const audit = UpsertAuditSchema.parse({
 *   id: 'idempotent-key-123',
 *   operation: 'createOrder',
 *   target: { app: 'Orders', type: 'Order', id: 'order-456' },
 *   status: 'success',
 * });
 * ```
 */
export const UpsertAuditSchema = z.object({
  ..._BaseLogAuditSchema.shape,
  /** Optional audit ID - auto-generated if not provided */
  id: z.string().optional(),
  /** Whether the audited operation can be re-run/retried */
  rerunable: z.boolean().optional(),
  /** History of execution attempts for retry tracking */
  attempts: z.array(AttemptSchema).optional(),
  /** Original creation timestamp (preserved on retries) */
  createdAt: DateTimeStringSchema.optional(),
});

/**
 * Input type for UpsertAuditSchema.
 *
 * Use this type when building audit objects for upsert operations.
 */
export type UpsertAuditInput = z.input<typeof UpsertAuditSchema>;

/**
 * Output type from UpsertAuditSchema.
 *
 * Validated and transformed audit ready for storage.
 */
export type UpsertAudit = z.output<typeof UpsertAuditSchema>;

/**
 * Creates a UpsertAuditSchema with typed app and resourceType schemas.
 *
 * Use this when you have a config with strict app/resourceType enums
 * to get runtime validation against those specific values.
 *
 * @param resourceReferenceSchema - The typed resource reference schema from config.schemas.resourceReference
 * @returns A UpsertAuditSchema that validates against the provided resource reference schema
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 *
 * const typedSchema = createTypedUpsertAuditSchema(config.schemas.resourceReference);
 * typedSchema.parse({
 *   operation: 'createOrder',
 *   target: { app: 'Orders', type: 'Order', id: '123' },
 * }); // Validates app/type against config
 * ```
 */
export function createTypedUpsertAuditSchema<
  T extends z.ZodObject<{
    app: z.ZodTypeAny;
    type: z.ZodTypeAny;
    id: z.ZodTypeAny;
  }>,
>(resourceReferenceSchema: T) {
  const typedLogSchema = createTypedLogAuditSchema(resourceReferenceSchema);

  return z.object({
    ...typedLogSchema.shape,
    /** Optional audit ID - auto-generated if not provided */
    id: z.string().optional(),
    /** Whether the audited operation can be re-run/retried */
    rerunable: z.boolean().optional(),
    /** History of execution attempts for retry tracking */
    attempts: z.array(AttemptSchema).optional(),
    /** Original creation timestamp (preserved on retries) */
    createdAt: DateTimeStringSchema.optional(),
  });
}
