import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../test-config.js";

const { mockListTraceItems } = vi.hoisted(() => ({
  mockListTraceItems: vi.fn(),
}));

vi.mock("../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

vi.mock("@flipboxlabs/aws-audit-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flipboxlabs/aws-audit-sdk")>();
  return {
    ...actual,
    AuditService: class MockAuditService {
      listTraceItems = mockListTraceItems;
    },
  };
});

vi.mock("@aws-lambda-powertools/logger", () => ({
  Logger: class MockLogger {},
}));

import { handler } from "./handler.js";

const createApiGatewayEvent = (
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 =>
  ({
    version: "2.0",
    routeKey: "GET /trace/{trace}",
    rawPath: "/trace/trace-123",
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
        path: "/trace/trace-123",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test-agent",
      },
      requestId: "request-id",
      routeKey: "GET /trace/{trace}",
      stage: "$default",
      time: "01/Jan/2024:00:00:00 +0000",
      timeEpoch: 1704067200000,
    },
    pathParameters: {
      trace: "trace-123",
    },
    isBase64Encoded: false,
    ...overrides,
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

describe("trace handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("GET /trace/:trace", () => {
    it("should return audit items for a trace id", async () => {
      const mockResponse = {
        items: [
          {
            id: "audit-123",
            status: "success",
            tier: 2,
            operation: "testOp",
            target: { app: App.App1, type: ResourceType.UNKNOWN },
          },
        ],
      };
      mockListTraceItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(mockListTraceItems).toHaveBeenCalledWith(
        { trace: "trace-123", app: undefined },
        undefined,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toBeDefined();
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });

    it("should pass pagination parameters to service", async () => {
      const mockResponse = {
        items: [],
        pagination: { nextToken: "next-page" },
      };
      mockListTraceItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent({
        rawQueryString: "pagination[pageSize]=25&pagination[nextToken]=abc123",
        queryStringParameters: {
          "pagination[pageSize]": "25",
          "pagination[nextToken]": "abc123",
        },
      });
      const response = await handler(event, mockContext);

      expect(mockListTraceItems).toHaveBeenCalledWith(
        { trace: "trace-123", app: undefined },
        { pageSize: 25, nextToken: "abc123" },
      );
      expect(response.statusCode).toBe(200);
    });

    it("should pass app filter to service", async () => {
      const mockResponse = { items: [] };
      mockListTraceItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent({
        rawQueryString: `filter[app]=${App.App1}`,
        queryStringParameters: {
          "filter[app]": App.App1,
        },
      });
      const response = await handler(event, mockContext);

      expect(mockListTraceItems).toHaveBeenCalledWith(
        { trace: "trace-123", app: App.App1 },
        undefined,
      );
      expect(response.statusCode).toBe(200);
    });

    it("should return 422 for invalid app filter", async () => {
      const event = createApiGatewayEvent({
        rawQueryString: "filter[app]=InvalidApp",
        queryStringParameters: {
          "filter[app]": "InvalidApp",
        },
      });
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(422);
      expect(mockListTraceItems).not.toHaveBeenCalled();
    });

    it("should return empty items array when no audits found", async () => {
      const mockResponse = { items: [] };
      mockListTraceItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent({
        pathParameters: { trace: "non-existent-trace" },
        rawPath: "/trace/non-existent-trace",
      });
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(200);
      expect(response.body).toBeDefined();
      expect(JSON.parse(response.body as string)).toEqual({ items: [] });
    });

    it("should handle service errors", async () => {
      mockListTraceItems.mockRejectedValue(new Error("Service error"));

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(500);
    });
  });
});
