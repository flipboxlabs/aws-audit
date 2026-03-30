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
const TierSchema = z.number().int().gte(1).lte(3);

/**
 * Schema for audit status enum values.
 * @internal
 */
const StatusSchema = z.enum(Object.values(Status));

/**
 * Schema for application identifier values.
 * Accepts any string; use config.schemas.app for strict validation.
 * @internal
 */
const AppSchema = z.string();

/**
 * Schema for resource type values.
 * Accepts any string; use config.schemas.resourceType for strict validation.
 * @internal
 */
const ResourceTypeSchema = z.string();

/**
 * Schema for resource references (target/source).
 *
 * Identifies a resource within an application by app, type, and optional ID.
 * @internal
 */
const ResourceReferenceSchema = z.object({
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
const AdditionalResourceSchema = ResourceReferenceSchema.extend({
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
const ContextSchema = z.record(z.string(), recursiveValueSchema);

/**
 * Schema for audit entries destined for CloudWatch Logs.
 *
 * This is the primary schema for creating audit log entries. It validates
 * and transforms input data into a consistent format for CloudWatch emission.
 *
 * **Transformations:**
 * - `resources`: Set is converted to Array
 * - `error`: Error instances are serialized to JSON strings
 * - `tier`: Defaults to 2 (INFO) if not provided
 * - `status`: Defaults to 'success' if not provided
 *
 * @example
 * ```typescript
 * const audit = LogAuditSchema.parse({
 *   operation: 'createUser',
 *   target: { app: 'MyApp', type: 'User', id: 'user-123' },
 *   status: 'success',
 *   context: { email: 'user@example.com' },
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With error handling
 * const failedAudit = LogAuditSchema.parse({
 *   operation: 'processPayment',
 *   target: { app: 'Payments', type: 'Payment', id: 'pay-456' },
 *   status: 'fail',
 *   error: new Error('Payment declined'),
 * });
 * // error is now a JSON string: '{"name":"Error","message":"Payment declined"}'
 * ```
 */
export const LogAuditSchema = z.object({
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
				e instanceof Error
					? JSON.stringify(e, Object.getOwnPropertyNames(e))
					: e,
			),
		),
});

/**
 * Input type for LogAuditSchema.
 *
 * Use this type when building audit objects before validation.
 * Accepts Error instances and Set for resources.
 */
export type LogAuditInput = z.input<typeof LogAuditSchema>;
