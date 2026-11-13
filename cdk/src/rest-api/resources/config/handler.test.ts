import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testConfig } from "../../../test-config.js";

vi.mock("../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

import { handler } from "./handler.js";

const createApiGatewayEvent = (): APIGatewayProxyEventV2 =>
  ({
    version: "2.0",
    routeKey: "GET /config",
    rawPath: "/config",
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
    },
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "api.example.com",
      domainPrefix: "api",
      http: {
        method: "GET",
        path: "/config",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test-agent",
      },
      requestId: "request-id",
      routeKey: "GET /config",
      stage: "$default",
      time: "01/Jan/2024:00:00:00 +0000",
      timeEpoch: 1704067200000,
    },
    isBase64Encoded: false,
  }) as APIGatewayProxyEventV2;

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "test-function",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
  memoryLimitInMB: "128",
  awsRequestId: "request-id",
  logGroupName: "/aws/lambda/test",
  logStreamName: "2024/01/01/[$LATEST]abc123",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

describe("config handler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("GET /config", () => {
    it("should return the configured apps, resource types, statuses and version", async () => {
      vi.stubEnv("AWS_AUDIT_CDK_VERSION", "1.6.0");

      const response = await handler(createApiGatewayEvent(), mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual({
        apps: ["App1", "TestApp"],
        resourceTypes: ["Unknown", "User", "Order"],
        statuses: ["success", "warn", "fail", "skip"],
        version: "1.6.0",
      });
    });

    it("should return 500 when the version was not injected", async () => {
      vi.stubEnv("AWS_AUDIT_CDK_VERSION", undefined);

      const response = await handler(createApiGatewayEvent(), mockContext);

      expect(response.statusCode).toBe(500);
    });
  });
});
