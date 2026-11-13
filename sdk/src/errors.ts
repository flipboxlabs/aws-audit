import type { Identifiers } from "./repository.js";

/**
 * Thrown by `AuditService.getItem` when no audit record exists for the given identifiers.
 *
 * Storage failures (DynamoDB errors, records that fail schema parsing) are not
 * reported with this error; they propagate as their original error instead.
 *
 * @example
 * ```typescript
 * try {
 *   const audit = await service.getItem({ id: 'audit-123', app: 'Orders', resourceType: 'Order' });
 * } catch (error) {
 *   if (error instanceof AuditNotFoundError) {
 *     // respond with 404
 *   }
 *   throw error;
 * }
 * ```
 */
export class AuditNotFoundError extends Error {
  /** The identifiers that were looked up */
  public readonly identifiers: Omit<Identifiers, "resourceId">;

  public constructor(identifiers: Omit<Identifiers, "resourceId">) {
    super(
      `Unable to find Audit ${Object.entries(identifiers)
        .map(([key, value]) => `${key}:${value}`)
        .join(" | ")}`,
    );
    this.name = "AuditNotFoundError";
    this.identifiers = identifiers;
  }
}
