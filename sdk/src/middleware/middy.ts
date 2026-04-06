import type { MiddlewareLikeObj, MiddyLikeRequest } from "@aws-lambda-powertools/commons/types";
import type { Audits } from "../audits.js";
import type { AuditConfig } from "../config.js";

/**
 * Type alias for any Audits instance regardless of config type.
 */
type AnyAudits = Audits<AuditConfig>;

/**
 * Creates a Middy.js middleware for automatic audit log management.
 *
 * This middleware integrates with the AWS Lambda Powertools pattern and is
 * compatible with `@middy/core@3.x` and above. It automates the lifecycle
 * of audit log collection and emission.
 *
 * **Behavior:**
 * - **Before hook**: Registers a cleanup function on `request.internal` that
 *   can be invoked by other middlewares for early termination scenarios
 * - **After hook**: Logs the Lambda event and publishes all buffered audits
 * - **OnError hook**: Same as after hook - ensures audits are published even
 *   when the handler throws an error
 *
 * The cleanup function is stored at `audits` in `request.internal`,
 * following the Powertools convention for middleware coordination.
 *
 * @param handler - The Audits instance to use for audit management
 * @returns A Middy-compatible middleware object with before, after, and onError hooks
 *
 * @example
 * ```typescript
 * import middy from '@middy/core';
 * import { Audits, defineAuditConfig } from '@flipboxlabs/aws-audit-sdk';
 * import { logAudits } from '@flipboxlabs/aws-audit-sdk/middleware';
 *
 * const config = defineAuditConfig({
 *   apps: ['Orders'] as const,
 *   resourceTypes: ['Order'] as const,
 * });
 *
 * const audits = new Audits({ config });
 *
 * const handler = middy(async (event, context) => {
 *   audits.addAudit({
 *     operation: 'processOrder',
 *     target: { app: 'Orders', type: 'Order', id: event.orderId },
 *     status: 'success',
 *   });
 *
 *   return { statusCode: 200 };
 * }).use(logAudits(audits));
 *
 * export { handler };
 * ```
 *
 * @example
 * ```typescript
 * // With multiple middlewares - cleanup function ensures audits
 * // are published even if another middleware returns early
 * const handler = middy(lambdaHandler)
 *   .use(logAudits(audits))
 *   .use(httpErrorHandler())
 *   .use(cors());
 * ```
 */
const logAudits = (handler: AnyAudits): MiddlewareLikeObj => {
  const instance = handler;

  /**
   * Registers the cleanup function on the request's internal state.
   *
   * This allows other middlewares to invoke the audit flush if they
   * need to return early, following the Powertools middleware pattern.
   *
   * @param request - The Middy request object
   * @internal
   */
  const setCleanupFunction = (request: MiddyLikeRequest): void => {
    request.internal = {
      ...request.internal,
      ["audits"]: afterOrError,
    };
  };

  /**
   * Before hook - runs before the Lambda handler.
   *
   * Registers the cleanup function for middleware coordination.
   *
   * @param request - The Middy request object
   * @internal
   */
  const before = async (request: MiddyLikeRequest): Promise<void> => {
    setCleanupFunction(request);
  };

  /**
   * After/Error hook - runs after the Lambda handler completes or throws.
   *
   * Logs the original event for debugging and publishes all buffered
   * audit entries. This ensures audits are always emitted regardless
   * of whether the handler succeeded or failed.
   *
   * @param request - The Middy request object containing the event
   * @internal
   */
  const afterOrError = async (request: MiddyLikeRequest): Promise<void> => {
    instance.logger.info(request.event);

    instance.publishStoredAudits();
  };

  return {
    before,
    after: afterOrError,
    onError: afterOrError,
  };
};

export { logAudits };
