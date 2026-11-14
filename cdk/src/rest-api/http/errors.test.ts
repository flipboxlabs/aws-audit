import { NotFoundError, Router } from "@aws-lambda-powertools/event-handler/http";
import type { Logger } from "@aws-lambda-powertools/logger";
import { InvalidNextTokenError } from "@flipboxlabs/aws-audit-sdk";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { describe, expect, it, vi } from "vite-plus/test";
import { registerErrorHandlers } from "./errors.js";

const event = {
  resource: "/test",
  path: "/test",
  httpMethod: "GET",
  headers: {},
  multiValueHeaders: {},
  pathParameters: null,
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  stageVariables: null,
  body: null,
  isBase64Encoded: false,
  requestContext: { httpMethod: "GET", path: "/test", resourcePath: "/test", stage: "test" },
} as unknown as APIGatewayProxyEvent;

const resolve = async (error: Error) => {
  const logger = { error: vi.fn() };
  const app = new Router();
  app.get("/test", async () => {
    throw error;
  });
  registerErrorHandlers(app, logger as unknown as Logger);

  const result = (await app.resolve(event, {} as Context)) as APIGatewayProxyResult;

  return { logger, statusCode: result.statusCode, body: JSON.parse(result.body) };
};

describe("registerErrorHandlers", () => {
  it("answers an unhandled error with an InternalServerError body and logs it", async () => {
    const error = new Error("Boom");

    const { logger, statusCode, body } = await resolve(error);

    expect(statusCode).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      error: "InternalServerError",
      message: "Internal Server Error",
    });
    expect(logger.error).toHaveBeenCalledWith("Unhandled error", error);
  });

  it("answers HTTP errors as they are, without logging them", async () => {
    const { logger, statusCode, body } = await resolve(new NotFoundError("Audit not found"));

    expect(statusCode).toBe(404);
    expect(body).toEqual({ statusCode: 404, error: "NotFoundError", message: "Audit not found" });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("answers an invalid nextToken as a query validation error", async () => {
    const { logger, statusCode, body } = await resolve(new InvalidNextTokenError());

    expect(statusCode).toBe(422);
    expect(body).toEqual({
      statusCode: 422,
      error: "RequestValidationError",
      message: "Validation failed for request",
      details: {
        issues: [{ message: "Invalid pagination token", path: ["query", "pagination[nextToken]"] }],
      },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
