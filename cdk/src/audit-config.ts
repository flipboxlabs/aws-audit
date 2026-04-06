import { defineAuditConfig } from "@flipboxlabs/aws-audit-sdk";
// @ts-expect-error - This import is resolved at runtime from the Lambda layer
import { apps, resourceTypes } from "/opt/nodejs/audit-config.js";

/**
 * Audit configuration loaded from the Lambda layer.
 *
 * The `apps` and `resourceTypes` arrays are provided by the AuditConfigLayer
 * construct at deploy time. This file creates the typed configuration object
 * that handlers use.
 *
 * @example
 * ```typescript
 * import { auditConfig, type App, type ResourceType } from '../../audit-config.js';
 *
 * // Use in handlers
 * const service = new AuditService(logger, auditConfig);
 *
 * // Use schemas for validation
 * const PathSchema = z.object({
 *   app: auditConfig.schemas.app,
 *   object: auditConfig.schemas.resourceType,
 * });
 * ```
 */
export const auditConfig = defineAuditConfig({
  apps: apps as readonly string[],
  resourceTypes: resourceTypes as readonly string[],
});

/**
 * Type alias for the App union type from the audit config.
 * Note: At compile time this is `string` since the actual values come from the layer.
 */
export type App = (typeof auditConfig)["_types"]["App"];

/**
 * Type alias for the ResourceType union type from the audit config.
 * Note: At compile time this is `string` since the actual values come from the layer.
 */
export type ResourceType = (typeof auditConfig)["_types"]["ResourceType"];
