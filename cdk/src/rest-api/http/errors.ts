import {
  HttpError,
  InternalServerError,
  RequestValidationError,
  type Router,
} from "@aws-lambda-powertools/event-handler/http";
import type { Logger } from "@aws-lambda-powertools/logger";
import { InvalidNextTokenError } from "@flipboxlabs/aws-audit-sdk";

/**
 * Registers the error handlers every REST router shares, so all of them answer
 * `{statusCode, error, message}` with the error's class name in `error`.
 *
 * Register a router's own handlers first: an error without a handler for its exact
 * class goes to the first one registered for a parent class.
 */
export const registerErrorHandlers = (app: Router, logger: Logger): void => {
  // A nextToken the listing didn't issue is reported like any other invalid query value.
  app.errorHandler(InvalidNextTokenError, () => {
    throw new RequestValidationError("Validation failed for request", [
      { message: "Invalid pagination token", path: ["query", "pagination[nextToken]"] },
    ]);
  });

  // Replaces Powertools' default, which answers "error":"Internal Server Error" and
  // logs the error only at debug level.
  app.errorHandler(Error, async (error) => {
    if (error instanceof HttpError) {
      return error.toWebResponse();
    }

    logger.error("Unhandled error", error);

    return new InternalServerError("Internal Server Error").toWebResponse();
  });
};
