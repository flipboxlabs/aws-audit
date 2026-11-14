import type { Middleware } from "@aws-lambda-powertools/event-handler/types";

/**
 * Removes the content type from 204 responses.
 *
 * The router starts every response as an empty text one and keeps its
 * `text/plain;charset=UTF-8` content type when the handler doesn't set its own.
 * A 204 has no body, so it has no content type.
 */
export const NoContentMiddleware = (): Middleware => {
  return async ({ reqCtx, next }) => {
    await next();

    if (reqCtx.res.status === 204) {
      reqCtx.res.headers.delete("content-type");
    }
  };
};
