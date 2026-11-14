import { Router } from "@aws-lambda-powertools/event-handler/http";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { describe, expect, it } from "vite-plus/test";
import { NoContentMiddleware } from "./no-content.js";

const event = {
  resource: "/test",
  path: "/test",
  httpMethod: "POST",
  headers: {},
  multiValueHeaders: {},
  pathParameters: null,
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  stageVariables: null,
  body: null,
  isBase64Encoded: false,
  requestContext: { httpMethod: "POST", path: "/test", resourcePath: "/test", stage: "test" },
} as unknown as APIGatewayProxyEvent;

const resolve = async (response: Response, middleware = true) => {
  const app = new Router();
  if (middleware) {
    app.use(NoContentMiddleware());
  }
  app.post("/test", async () => response);

  return (await app.resolve(event, {} as Context)) as APIGatewayProxyResult;
};

describe("NoContentMiddleware", () => {
  it("removes the router's default content type from a 204", async () => {
    // Without it, the router's starting text/plain content type is kept
    const before = await resolve(new Response(undefined, { status: 204 }), false);
    expect(before.headers?.["content-type"]).toBe("text/plain;charset=UTF-8");

    const result = await resolve(new Response(undefined, { status: 204 }));

    expect(result.statusCode).toBe(204);
    expect(result.headers?.["content-type"]).toBeUndefined();
    expect(result.body).toBe("");
  });

  it("leaves other responses' content type alone", async () => {
    const result = await resolve(Response.json({ ok: true }, { status: 200 }));

    expect(result.headers?.["content-type"]).toBe("application/json");
  });
});
