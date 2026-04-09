/**
 * Schema module barrel file.
 *
 * Re-exports all schema definitions, types, and validation utilities
 * for use throughout the audit SDK.
 *
 * @module schema
 *
 * @example
 * ```typescript
 * import {
 *   AuditSchema,
 *   createTypedLogAuditSchema,
 *   Status,
 *   Tier,
 *   type Audit,
 *   type LogAuditInput,
 * } from '@flipboxlabs/aws-audit-sdk/schema';
 * ```
 */
export * from "./audit.js";
export { type AdditionalResource, type AnyTier, type ResourceReference, Tier } from "./common.js";
export { type AnyStatus, createTypedLogAuditSchema, type LogAuditInput, Status } from "./log.js";
export * from "./model.js";
export * from "./service.js";
export * from "./storage.js";
