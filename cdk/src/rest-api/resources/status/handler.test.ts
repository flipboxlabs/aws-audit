import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, ResourceType, testConfig } from "../../../test-config.js";

const { mockListByStatus } = vi.hoisted(() => ({
  mockListByStatus: vi.fn(),
}));

vi.mock("../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

vi.mock("@flipboxlabs/aws-audit-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flipboxlabs/aws-audit-sdk")>();
  return {
    ...actual,
    AuditService: class MockAuditService {
      listByStatus = mockListByStatus;
    },
  };
});

vi.mock("@aws-lambda-powertools/logger", () => ({
  Logger: class MockLogger {},
}));

import { handler } from "./handler.js";

const createApiGatewayEvent = (
  status = "fail",
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 =>
  ({
    version: "2.0",
    routeKey: `GET /status/{status}`,
    rawPath: `/status/${status}`,
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
        path: `/status/${status}`,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test-agent",
      },
      requestId: "request-id",
      routeKey: `GET /status/{status}`,
      stage: "$default",
      time: "01/Jan/2024:00:00:00 +0000",
      timeEpoch: 1704067200000,
    },
    pathParameters: {
      status,
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

describe("status handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("GET /status/:status", () => {
    it("should return audit items for a valid status", async () => {
      const mockResponse = {
        items: [
          {
            id: "audit-123",
            status: "fail",
            tier: 2,
            operation: "testOp",
            target: { app: App.App1, type: ResourceType.UNKNOWN },
          },
        ],
      };
      mockListByStatus.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent("fail");
      const response = await handler(event, mockContext);

      expect(mockListByStatus).toHaveBeenCalledWith(
        { status: "fail", app: undefined, resource: undefined },
        undefined,
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).toBeDefined();
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });

    it("should return 422 for invalid status", async () => {
      const event = createApiGatewayEvent("invalid-status");
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(422);
      expect(mockListByStatus).not.toHaveBeenCalled();
    });

    it("should pass pagination parameters to service", async () => {
      const mockResponse = {
        items: [],
        pagination: { nextToken: "next-page" },
      };
      mockListByStatus.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent("warn", {
        rawQueryString: "pagination[pageSize]=25&pagination[nextToken]=abc123",
        queryStringParameters: {
          "pagination[pageSize]": "25",
          "pagination[nextToken]": "abc123",
        },
      });
      const response = await handler(event, mockContext);

      expect(mockListByStatus).toHaveBeenCalledWith(
        { status: "warn", app: undefined, resource: undefined },
        { pageSize: 25, nextToken: "abc123" },
      );
      expect(response.statusCode).toBe(200);
    });

    it("should pass app filter to service", async () => {
      const mockResponse = { items: [] };
      mockListByStatus.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent("success", {
        rawQueryString: `filter[app]=${App.App1}`,
        queryStringParameters: {
          "filter[app]": App.App1,
        },
      });
      const response = await handler(event, mockContext);

      expect(mockListByStatus).toHaveBeenCalledWith(
        { status: "success", app: App.App1, resource: undefined },
        undefined,
      );
      expect(response.statusCode).toBe(200);
    });

    it("should pass resourceType filter to service", async () => {
      const mockResponse = { items: [] };
      mockListByStatus.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent("fail", {
        rawQueryString: `filter[resourceType]=${ResourceType.ORDER}`,
        queryStringParameters: {
          "filter[resourceType]": ResourceType.ORDER,
        },
      });
      const response = await handler(event, mockContext);

      expect(mockListByStatus).toHaveBeenCalledWith(
        {
          status: "fail",
          app: undefined,
          resource: { type: ResourceType.ORDER },
        },
        undefined,
      );
      expect(response.statusCode).toBe(200);
    });

    it("should return 422 for invalid app filter", async () => {
      const event = createApiGatewayEvent("fail", {
        rawQueryString: "filter[app]=InvalidApp",
        queryStringParameters: {
          "filter[app]": "InvalidApp",
        },
      });
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(422);
      expect(mockListByStatus).not.toHaveBeenCalled();
    });

    it("should return empty items array when no audits found", async () => {
      const mockResponse = { items: [] };
      mockListByStatus.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent("skip");
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual({ items: [] });
    });

    it("should handle service errors", async () => {
      mockListByStatus.mockRejectedValue(new Error("Service error"));

      const event = createApiGatewayEvent("fail");
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(500);
    });
  });
});
