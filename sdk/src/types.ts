import type { AuditConfig } from "./config.js";

/**
 * Extracts the App type from an AuditConfig.
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 *
 * type App = InferApp<typeof config>; // 'Orders' | 'Inventory'
 * ```
 */
export type InferApp<C extends AuditConfig> = C["_types"]["App"];

/**
 * Extracts the ResourceType type from an AuditConfig.
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 *
 * type ResourceType = InferResourceType<typeof config>; // 'Order' | 'Product'
 * ```
 */
export type InferResourceType<C extends AuditConfig> = C["_types"]["ResourceType"];

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
