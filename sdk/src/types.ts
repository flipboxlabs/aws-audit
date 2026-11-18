import type { AuditConfig } from "./config.js";

/**
 * Extracts the App type from an AuditConfig.
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: { Orders: ['Order'], Inventory: ['Product'] },
 * });
 *
 * type App = InferApp<typeof config>; // 'Orders' | 'Inventory'
 * ```
 */
export type InferApp<C extends AuditConfig> = C["_types"]["App"];

/**
 * Extracts the resource types of app `A` from an AuditConfig, or of every app
 * without `A`.
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: { Orders: ['Order', 'Customer'], Inventory: ['Product'] },
 * });
 *
 * type OrderType = InferResourceType<typeof config, 'Orders'>; // 'Order' | 'Customer'
 * type AnyType = InferResourceType<typeof config>; // 'Order' | 'Customer' | 'Product'
 * ```
 */
export type InferResourceType<
  C extends AuditConfig,
  A extends InferApp<C> = InferApp<C>,
> = C["_types"]["ResourceTypes"][A];

/**
 * Each app of an AuditConfig with one of its resource types, as a union keyed on
 * `app`: naming the app narrows `type` to that app's types.
 *
 * @example
 * ```typescript
 * type Resource = InferResource<typeof config>;
 * // { app: 'Orders'; type: 'Order' | 'Customer' } | { app: 'Inventory'; type: 'Product' }
 * ```
 */
export type InferResource<C extends AuditConfig> = {
  [A in InferApp<C>]: { app: A; type: InferResourceType<C, A> };
}[InferApp<C>];

/**
 * Generic App type - accepts any string.
 * For strict typing, use InferApp<typeof config> with your config.
 */
export type AnyApp = string;

/**
 * Generic ResourceType type - accepts any string.
 * For strict typing, use InferResourceType<typeof config> with your config.
 */
export type AnyResourceType = string;
