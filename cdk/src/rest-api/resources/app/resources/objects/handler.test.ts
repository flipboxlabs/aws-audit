import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../../../test-config.js";

const { mockListItems } = vi.hoisted(() => ({
  mockListItems: vi.fn(),
}));

vi.mock("../../../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

vi.mock("@flipboxlabs/aws-audit-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flipboxlabs/aws-audit-sdk")>();
  return {
    ...actual,
    AuditService: class MockAuditService {
      listItems = mockListItems;
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
    routeKey: "GET /apps/{app}/objects/{object}/{item}",
    rawPath: `/apps/${App.App1}/objects/${ResourceType.UNKNOWN}/item-123`,
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
        path: `/apps/${App.App1}/objects/${ResourceType.UNKNOWN}/item-123`,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test-agent",
      },
      requestId: "request-id",
      routeKey: "GET /apps/{app}/objects/{object}/{item}",
      stage: "$default",
      time: "01/Jan/2024:00:00:00 +0000",
      timeEpoch: 1704067200000,
    },
    pathParameters: {
      app: App.App1,
      object: ResourceType.UNKNOWN,
      item: "item-123",
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

describe("objects handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("GET /apps/:app/objects/:object/:item", () => {
    it("should return audit items for a resource", async () => {
      const mockResponse = {
        items: [
          {
            id: "audit-123",
            status: "success",
            tier: 2,
            operation: "testOp",
            target: {
              app: App.App1,
              type: ResourceType.UNKNOWN,
              id: "item-123",
            },
          },
        ],
      };
      mockListItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(mockListItems).toHaveBeenCalledWith(
        {
          resource: { type: ResourceType.UNKNOWN, id: "item-123" },
          app: App.App1,
        },
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
      mockListItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent({
        rawQueryString: "pagination[pageSize]=50&pagination[nextToken]=token123",
        queryStringParameters: {
          "pagination[pageSize]": "50",
          "pagination[nextToken]": "token123",
        },
      });
      const response = await handler(event, mockContext);

      expect(mockListItems).toHaveBeenCalledWith(
        {
          resource: { type: ResourceType.UNKNOWN, id: "item-123" },
          app: App.App1,
        },
        { pageSize: 50, nextToken: "token123" },
      );
      expect(response.statusCode).toBe(200);
    });

    it("should return 422 for invalid app parameter", async () => {
      const event = createApiGatewayEvent({
        rawPath: `/apps/InvalidApp/objects/${ResourceType.UNKNOWN}/item-123`,
        pathParameters: {
          app: "InvalidApp",
          object: ResourceType.UNKNOWN,
          item: "item-123",
        },
      });
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(422);
      expect(mockListItems).not.toHaveBeenCalled();
    });

    it("should return 422 for invalid resource type", async () => {
      const event = createApiGatewayEvent({
        rawPath: `/apps/${App.App1}/objects/InvalidType/item-123`,
        pathParameters: {
          app: App.App1,
          object: "InvalidType",
          item: "item-123",
        },
      });
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(422);
      expect(mockListItems).not.toHaveBeenCalled();
    });

    it("should return empty items array when no audits found", async () => {
      const mockResponse = { items: [] };
      mockListItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(200);
      expect(response.body).toBeDefined();
      expect(JSON.parse(response.body as string)).toEqual({ items: [] });
    });

    it("should handle service errors", async () => {
      mockListItems.mockRejectedValue(new Error("Service error"));

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(500);
    });

    it("should accept numeric item id as string", async () => {
      const mockResponse = { items: [] };
      mockListItems.mockResolvedValue(mockResponse);

      const event = createApiGatewayEvent({
        rawPath: `/apps/${App.App1}/objects/${ResourceType.UNKNOWN}/12345`,
        pathParameters: {
          app: App.App1,
          object: ResourceType.UNKNOWN,
          item: "12345",
        },
      });
      const response = await handler(event, mockContext);

      expect(mockListItems).toHaveBeenCalledWith(
        {
          resource: { type: ResourceType.UNKNOWN, id: "12345" },
          app: App.App1,
        },
        undefined,
      );
      expect(response.statusCode).toBe(200);
    });
  });
});
