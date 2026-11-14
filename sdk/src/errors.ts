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
    this.identifiers = { ...identifiers };
  }
}

/**
 * Thrown by the listing methods when `pagination.nextToken` is not a token that
 * listing returned: it doesn't decode, it holds another index's keys, or it was
 * issued for another partition (status, trace, resource or tenant).
 *
 * The listing is not queried. Answer it as a client error.
 *
 * @example
 * ```typescript
 * try {
 *   return await service.listByStatus({ status: 'fail' }, { nextToken });
 * } catch (error) {
 *   if (error instanceof InvalidNextTokenError) {
 *     // respond with 400
 *   }
 *   throw error;
 * }
 * ```
 */
export class InvalidNextTokenError extends Error {
  public constructor(message = "Invalid pagination nextToken") {
    super(message);
    this.name = "InvalidNextTokenError";
  }
}
