import * as z from "zod/v4";
import { EventBridgeEventSchema } from "./model.js";

/**
 * Audit operation status values.
 *
 * Used to indicate the outcome of an audited operation:
 * - `SUCCESS`: Operation completed successfully
 * - `WARN`: Operation completed with warnings
 * - `FAIL`: Operation failed
 * - `SKIP`: Operation was skipped
 */
export const Status = {
  SUCCESS: "success",
  WARN: "warn",
  FAIL: "fail",
  SKIP: "skip",
} as const;

/**
 * Union type of all valid status values.
 */
export type AnyStatus = (typeof Status)[keyof typeof Status];

/**
 * Schema for escalation tier values (1-3).
 * @internal
 */
export const TierSchema = z.number().int().gte(1).lte(3);

/**
 * Schema for audit status enum values.
 * @internal
 */
export const StatusSchema = z.enum(Object.values(Status));

/**
 * Schema for application identifier values.
 * Accepts any string; use config.schemas.app for strict validation.
 * @internal
 */
export const AppSchema = z.string();

/**
 * Schema for resource type values.
 * Accepts any string; use config.schemas.resourceType for strict validation.
 * @internal
 */
export const ResourceTypeSchema = z.string();

/**
 * Schema for resource references (target/source).
 *
 * Identifies a resource within an application by app, type, and optional ID.
 * @internal
 */
export const ResourceReferenceSchema = z.object({
  /** Application that owns this resource */
  app: AppSchema,
  /** Unique identifier within the resource type (optional) */
  id: z.union([z.string(), z.number()]).optional(),
  /** Type/category of the resource */
  type: ResourceTypeSchema,
});

/**
 * Schema for additional related resources.
 *
 * Same structure as ResourceReferenceSchema, used for linking
 * secondary resources to an audit entry.
 * @internal
 */
export const AdditionalResourceSchema = ResourceReferenceSchema.extend({
  id: z.union([z.string(), z.number()]).optional(),
});

/**
 * Recursive type for context values.
 *
 * Supports primitives (string, number, boolean) and nested objects
 * for flexible metadata storage.
 */
type ContextValue = string | number | boolean | { [key: string]: ContextValue };

/**
 * Schema for recursive context values.
 *
 * Validates nested key-value structures for audit metadata.
 * @internal
 */
const recursiveValueSchema: z.ZodType<ContextValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.lazy(() => z.record(z.string(), recursiveValueSchema)),
]);

/**
 * Schema for the context object - a flexible key-value store.
 * @internal
 */
export const ContextSchema = z.record(z.string(), recursiveValueSchema);

/**
 * Base schema for audit entries destined for CloudWatch Logs.
 *
 * @internal Use `createTypedLogAuditSchema` instead for type-safe validation
 * with your config's app and resourceType enums.
 *
 * This schema accepts any string for app and resourceType values.
 * For strict validation against configured values, use the factory function.
 *
 * **Transformations:**
 * - `resources`: Set is converted to Array
 * - `error`: Error instances are serialized to JSON strings
 * - `tier`: Defaults to 2 (INFO) if not provided
 * - `status`: Defaults to 'success' if not provided
 */
export const _BaseLogAuditSchema = z.object({
  /** Optional audit ID for retry correlation. If provided, retries with the same ID are correlated. */
  id: z.string().optional(),
  /** Name of the operation being audited (required) */
  operation: z.string(),
  /** Tenant identifier for multi-tenancy support (optional) */
  tenantId: z.string().optional(),
  /** Escalation tier for visibility (1=internal, 2=info, 3=public). Defaults to 2. */
  tier: TierSchema.default(2),
  /** Outcome status of the operation. Defaults to 'success'. */
  status: StatusSchema.default(Status.SUCCESS),
  /** The primary resource being audited (required) */
  target: ResourceReferenceSchema,
  /** The resource that initiated the operation (optional) */
  source: ResourceReferenceSchema.optional(),
  /** Additional metadata as key-value pairs (optional) */
  context: ContextSchema.optional(),
  /** Additional resources affected by this operation. Set is converted to Array. */
  resources: z
    .union([z.array(AdditionalResourceSchema), z.set(AdditionalResourceSchema)])
    .optional()
    .pipe(z.transform((val) => (val instanceof Set ? Array.from(val) : val))),
  /** Human-readable description of the audit (optional) */
  message: z.string().optional(),
  /** Trace identifier for distributed tracing (optional) */
  trace: z.string().optional(),
  /** Original EventBridge event that triggered this audit (optional) */
  event: EventBridgeEventSchema.optional(),
  /** Error details if the operation failed. Error instances are JSON serialized. */
  error: z
    .union([z.string(), z.instanceof(Error)])
    .optional()
    .pipe(
      z.transform((e) =>
        e instanceof Error ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : e,
      ),
    ),
});

/**
 * Input type for log audit schemas.
 *
 * Use this type when building audit objects before validation.
 * Accepts Error instances and Set for resources.
 */
export type LogAuditInput = z.input<typeof _BaseLogAuditSchema>;

/**
 * Creates a LogAuditSchema with typed app and resourceType schemas.
 *
 * Use this when you have a config with strict app/resourceType enums
 * to get runtime validation against those specific values.
 *
 * @param resourceReferenceSchema - The typed resource reference schema from config.schemas.resourceReference
 * @returns A LogAuditSchema that validates against the provided resource reference schema
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 *
 * const typedSchema = createTypedLogAuditSchema(config.schemas.resourceReference);
 * typedSchema.parse({
 *   operation: 'createOrder',
 *   target: { app: 'Orders', type: 'Order', id: '123' },
 * }); // Validates app/type against config
 * ```
 */
export function createTypedLogAuditSchema<
  T extends z.ZodObject<{
    app: z.ZodTypeAny;
    type: z.ZodTypeAny;
    id: z.ZodTypeAny;
  }>,
>(resourceReferenceSchema: T) {
  return z.object({
    id: z.string().optional(),
    operation: z.string(),
    tenantId: z.string().optional(),
    tier: TierSchema.default(2),
    status: StatusSchema.default(Status.SUCCESS),
    target: resourceReferenceSchema,
    source: resourceReferenceSchema.optional(),
    context: ContextSchema.optional(),
    resources: z
      .union([z.array(resourceReferenceSchema), z.set(resourceReferenceSchema)])
      .optional()
      .pipe(z.transform((val) => (val instanceof Set ? Array.from(val) : val))),
    message: z.string().optional(),
    trace: z.string().optional(),
    event: EventBridgeEventSchema.optional(),
    error: z
      .union([z.string(), z.instanceof(Error)])
      .optional()
      .pipe(
        z.transform((e) =>
          e instanceof Error ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : e,
        ),
      ),
  });
}
