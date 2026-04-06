import * as z from "zod/v4";

/**
 * Input configuration for defining audit apps and resource types.
 */
export interface AuditConfigInput {
  readonly apps: readonly string[];
  readonly resourceTypes: readonly string[];
  readonly service?: string;
}

/**
 * Creates an audit configuration object with typed schemas.
 *
 * The returned config object contains:
 * - `service`: The service version (defaults to "v1")
 * - `schemas.app`: Zod schema for validating app values
 * - `schemas.resourceType`: Zod schema for validating resource type values
 * - `schemas.resourceReference`: Zod schema for validating resource references
 * - `_types`: Type helpers for extracting App and ResourceType union types
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 *
 * // Extract types for use in application code
 * type App = typeof config._types.App; // 'Orders' | 'Inventory'
 * type ResourceType = typeof config._types.ResourceType; // 'Order' | 'Product'
 *
 * // Use schemas for validation
 * config.schemas.app.parse('Orders'); // ✅
 * config.schemas.app.parse('Invalid'); // ❌ throws
 * ```
 */
export function defineAuditConfig<const C extends AuditConfigInput>(input: C) {
  type App = C["apps"][number];
  type ResourceType = C["resourceTypes"][number];

  const schemas = {
    app: z.enum(input.apps as [string, ...string[]]),
    resourceType: z.enum(input.resourceTypes as [string, ...string[]]),
    resourceReference: z.object({
      app: z.enum(input.apps as [string, ...string[]]),
      type: z.enum(input.resourceTypes as [string, ...string[]]),
      id: z.union([z.string(), z.number()]).optional(),
    }),
  };

  return {
    service: process.env.SERVICE,
    ...input,
    schemas,
    _types: {} as {
      App: App;
      ResourceType: ResourceType;
    },
  };
}

/**
 * Type representing the return value of defineAuditConfig.
 */
export type AuditConfig = ReturnType<typeof defineAuditConfig>;
