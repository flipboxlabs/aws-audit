import * as z from "zod/v4";

/**
 * Default TTL for audit records in seconds (90 days).
 */
export const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 90;

/**
 * What an app or resource type name may hold: letters, digits, `-` and `_`. Names
 * are path segments of the REST API (`/apps/{app}/objects/{type}`), so they must
 * be URL-safe as they are.
 */
export const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Input configuration: each app, with the resource types it has.
 */
export interface AuditConfigInput {
  /**
   * Each app's resource types, e.g. `{ HubSpot: ["Contact", "Company"] }`. Names
   * must match {@link NAME_PATTERN}; an app needs at least one type, and two apps
   * may share a type's name.
   */
  readonly apps: { readonly [app: string]: readonly string[] };
  readonly service?: string;
  /**
   * Time-to-live for audit records in seconds.
   * DynamoDB will automatically delete records after this period.
   * @default 7776000 (90 days)
   */
  readonly ttlSeconds?: number;
}

/**
 * Why an audit config is refused, or undefined when it's valid: an object mapping
 * at least one app to an array of at least one resource type, every name URL-safe
 * ({@link NAME_PATTERN}). The CDK config layer and the Rust Lambdas check the same;
 * the shape is checked too, for JavaScript callers, as the Rust Lambdas read only
 * a map of arrays (an earlier `apps: ["Orders"]` would load as an app named "0").
 */
export function auditConfigProblem(apps: AuditConfigInput["apps"]): string | undefined {
  if (typeof apps !== "object" || apps === null || Array.isArray(apps)) {
    return 'apps must map each app to its resource types, such as { Orders: ["Order"] }';
  }
  const entries = Object.entries(apps as Record<string, unknown>);
  if (entries.length === 0) return "apps must list at least one app";

  for (const [app, types] of entries) {
    if (!NAME_PATTERN.test(app)) {
      return `App "${app}" must hold only letters, digits, - and _`;
    }
    if (!Array.isArray(types) || types.some((type) => typeof type !== "string")) {
      return `App "${app}" must list its resource types as an array of strings`;
    }
    if (types.length === 0) return `App "${app}" must list at least one resource type`;
    for (const type of types as string[]) {
      if (!NAME_PATTERN.test(type)) {
        return `Resource type "${type}" of app "${app}" must hold only letters, digits, - and _`;
      }
    }
  }
  return undefined;
}

/**
 * Creates an audit configuration object with typed schemas.
 *
 * The returned config object contains:
 * - `apps`: Each app's resource types, as given
 * - `service`: The service version (defaults to `process.env.SERVICE`)
 * - `schemas.app`: Zod schema for validating app values
 * - `schemas.resourceType`: Zod schema for validating a resource type of any app
 * - `schemas.resourceReference`: Zod schema for validating resource references: the
 *   app, then the type against that app's types
 * - `_types`: Type helpers for extracting App and ResourceType union types
 *
 * @throws {Error} When an app has no resource types, or a name isn't URL-safe
 *   ({@link NAME_PATTERN})
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: {
 *     Orders: ['Order', 'Customer'],
 *     Inventory: ['Product'],
 *   },
 * });
 *
 * // Extract types for use in application code
 * type App = InferApp<typeof config>; // 'Orders' | 'Inventory'
 * type OrderType = InferResourceType<typeof config, 'Orders'>; // 'Order' | 'Customer'
 *
 * // Use schemas for validation
 * config.schemas.resourceReference.parse({ app: 'Orders', type: 'Order' }); // ✅
 * config.schemas.resourceReference.parse({ app: 'Orders', type: 'Product' }); // ❌ throws
 * ```
 */
export function defineAuditConfig<const C extends AuditConfigInput>(input: C) {
  type App = keyof C["apps"] & string;

  const problem = auditConfigProblem(input.apps);
  if (problem) throw new Error(problem);

  const apps = Object.keys(input.apps) as [App, ...App[]];
  const resourceTypes = [...new Set(Object.values(input.apps).flat())] as [string, ...string[]];
  const app = z.enum(apps);

  const schemas = {
    app,
    resourceType: z.enum(resourceTypes),
    resourceReference: z
      .object({
        app,
        type: z.string(),
        id: z.union([z.string(), z.number()]).optional(),
      })
      // Runs once the app is valid, so its types are known
      .superRefine((reference, ctx) => {
        const types = input.apps[reference.app] as [string, ...string[]];
        const result = z.enum(types).safeParse(reference.type);
        for (const issue of result.error?.issues ?? []) {
          ctx.addIssue({ ...issue, path: ["type"] } as z.core.$ZodRawIssue);
        }
      }),
  };

  return {
    ...input,
    ttlSeconds: input.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    get service() {
      return input.service ?? process.env.SERVICE;
    },
    schemas,
    _types: {} as {
      App: App;
      /** A resource type of any app */
      ResourceType: C["apps"][App][number];
      /** Each app's resource types */
      ResourceTypes: { [A in App]: C["apps"][A][number] };
    },
  };
}

/**
 * Type representing the return value of defineAuditConfig.
 */
export type AuditConfig = ReturnType<typeof defineAuditConfig>;
