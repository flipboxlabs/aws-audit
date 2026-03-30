import * as z from "zod/v4";
import { Status } from "./log.js";
import { EventBridgeEventSchema } from "./model.js";

/**
 * Escalation tiers for audit visibility
 * - INTERNAL (1): Internal system audits, not shown to end users
 * - INFO (2): Informational audits, shown in detailed views
 * - PUBLIC (3): Public audits, shown in summary views
 */
export const Tier = {
	INTERNAL: 1,
	INFO: 2,
	PUBLIC: 3,
} as const;
export type AnyTier = (typeof Tier)[keyof typeof Tier];

/**
 * Schema for escalation tier values (1-3)
 */
const TierSchema = z.number().int().gte(1).lte(3);

/**
 * Schema for audit status values (success, warn, fail, skip)
 */
export const StatusSchema = z.enum(Object.values(Status));

/**
 * Schema for application identifiers.
 * Accepts any string; use config.schemas.app for strict validation.
 */
const AppSchema = z.string();

/**
 * Schema for resource type identifiers.
 * Accepts any string; use config.schemas.resourceType for strict validation.
 */
const ResourceTypeSchema = z.string();

/**
 * Schema for referencing a resource within an application
 * Used to identify the target or source of an audit
 */
const ResourceReferenceSchema = z.object({
	app: AppSchema,
	id: z.union([z.string(), z.number()]).optional(),
	type: ResourceTypeSchema,
});
export type ResourceReference = z.output<typeof ResourceReferenceSchema>;

/**
 * Schema for additional related resources
 * Extends ResourceReferenceSchema for linking secondary resources to an audit
 */
const AdditionalResourceSchema = ResourceReferenceSchema.extend({
	id: z.union([z.string(), z.number()]).optional(),
});
export type AdditionalResource = z.output<typeof AdditionalResourceSchema>;

/**
 * Recursive type for context values
 * Supports strings, numbers, booleans, and nested objects
 */
type ContextValue = string | number | boolean | { [key: string]: ContextValue };

/**
 * Schema for recursive context values
 * Allows nested key-value structures for storing audit metadata
 */
const RecursiveContextValueSchema: z.ZodType<ContextValue> = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.lazy(() => z.record(z.string(), RecursiveContextValueSchema)),
]);

/**
 * Schema for audit context - a key-value store for additional metadata
 */
const ContextSchema = z.record(z.string(), RecursiveContextValueSchema);

/**
 * Schema for error details in audits and attempts.
 * Handles string errors (with optional JSON parsing), Error instances, and plain objects.
 */
const ErrorSchema = z
	.union([
		z.string().transform((error) => {
			try {
				return JSON.parse(error);
			} catch {
				return error;
			}
		}),
		z
			.instanceof(Error)
			.transform((error) =>
				JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error))),
			),
		z.record(z.any(), z.any()),
	])
	.optional();

export const DateTimeObjectSchema = z
	.union([z.iso.datetime(), z.instanceof(Date)])
	.transform((val) => new Date(val));

/**
 * Schema for datetime fields that accept ISO strings or Date objects.
 * Transforms Date objects to ISO strings for storage compatibility.
 *
 * @example
 * ```typescript
 * DateTimeSchema.parse("2024-01-01T12:00:00.000Z"); // "2024-01-01T12:00:00.000Z"
 * DateTimeSchema.parse(new Date()); // "2024-01-15T10:30:00.000Z"
 * ```
 */
export const DateTimeStringSchema = z
	.union([z.iso.datetime(), z.instanceof(Date)])
	.transform((val) => (val instanceof Date ? val.toISOString() : val));

/**
 * Schema for tracking individual retry attempts
 * Each attempt records the outcome and timing of a single execution
 */
export const AttemptSchema = z.object({
	/** Sequential attempt number (1-indexed) */
	number: z.number().int().min(1),
	/** Outcome of this attempt */
	status: StatusSchema,
	/** Error details if the attempt failed */
	error: ErrorSchema,
	/** ISO timestamp when this attempt occurred */
	at: DateTimeStringSchema.default(() => new Date().toISOString()),
});
export type Attempt = z.output<typeof AttemptSchema>;

/**
 * Base schema for audit records
 * Internal use only within the schema directory - not exported from index
 *
 * @internal
 */
export const BaseSchema = z.object({
	/** Unique identifier for the audit record */
	id: z.string(),
	/** Tenant identifier for multi-tenancy support (optional) */
	tenantId: z.string().optional(),
	/** Current status of the audited operation */
	status: StatusSchema,
	/** Escalation tier for visibility (defaults to INFO) */
	tier: TierSchema.default(2),
	/** The primary resource being audited */
	target: ResourceReferenceSchema,
	/** The resource that initiated the operation (optional) */
	source: ResourceReferenceSchema.optional(),
	/** Additional metadata as key-value pairs */
	context: ContextSchema.optional(),
	/** Name of the operation being audited */
	operation: z.string(),
	/** Human-readable description of the audit */
	message: z.string().optional(),
	/** Whether this audit can be re-run/retried */
	rerunable: z.boolean().optional(),
	/** Trace identifier for distributed tracing */
	trace: z.string().optional(),
	/** Original EventBridge event that triggered this audit */
	event: EventBridgeEventSchema.optional(),
	/** Error details if the operation failed */
	error: ErrorSchema,
	/** History of all execution attempts for retry tracking */
	attempts: z.array(AttemptSchema).optional(),
});
