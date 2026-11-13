import { AuditNotFoundError } from "@flipboxlabs/aws-audit-sdk";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../../../test-config.js";

const { mockGetItem, mockListItems, mockListObjects } = vi.hoisted(() => ({
  mockGetItem: vi.fn(),
  mockListItems: vi.fn(),
  mockListObjects: vi.fn(),
}));

vi.mock("../../../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

vi.mock("@flipboxlabs/aws-audit-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flipboxlabs/aws-audit-sdk")>();
  return {
    ...actual,
    AuditService: class MockAuditService {
      getItem = mockGetItem;
      listItems = mockListItems;
      listObjects = mockListObjects;
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

const createObjectApiGatewayEvent = (
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 => {
  const baseEvent = createApiGatewayEvent();
  const rawPath = `/apps/${App.App1}/objects/${ResourceType.UNKNOWN}`;

  return createApiGatewayEvent({
    routeKey: "GET /apps/{app}/objects/{object}",
    rawPath,
    requestContext: {
      ...baseEvent.requestContext,
      routeKey: "GET /apps/{app}/objects/{object}",
      http: {
        ...baseEvent.requestContext.http,
        path: rawPath,
      },
    },
    pathParameters: {
      app: App.App1,
      object: ResourceType.UNKNOWN,
    },
    ...overrides,
  });
};

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

  describe("GET /apps/:app/objects/:object", () => {
    it("should return audit items for an object type", async () => {
      const mockResponse = { items: [] };
      mockListObjects.mockResolvedValue(mockResponse);

      const response = await handler(createObjectApiGatewayEvent(), mockContext);

      expect(mockListObjects).toHaveBeenCalledWith(
        {
          resource: { type: ResourceType.UNKNOWN },
          app: App.App1,
        },
        undefined,
      );
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });

    it("should pass pagination parameters to the service", async () => {
      const mockResponse = {
        items: [],
        pagination: { nextToken: "next-page" },
      };
      mockListObjects.mockResolvedValue(mockResponse);

      const response = await handler(
        createObjectApiGatewayEvent({
          rawQueryString: "pagination[pageSize]=50&pagination[nextToken]=token123",
          queryStringParameters: {
            "pagination[pageSize]": "50",
            "pagination[nextToken]": "token123",
          },
        }),
        mockContext,
      );

      expect(mockListObjects).toHaveBeenCalledWith(
        {
          resource: { type: ResourceType.UNKNOWN },
          app: App.App1,
        },
        { pageSize: 50, nextToken: "token123" },
      );
      expect(response.statusCode).toBe(200);
    });

    it("should return 422 for an invalid app", async () => {
      const response = await handler(
        createObjectApiGatewayEvent({
          rawPath: `/apps/InvalidApp/objects/${ResourceType.UNKNOWN}`,
          pathParameters: {
            app: "InvalidApp",
            object: ResourceType.UNKNOWN,
          },
        }),
        mockContext,
      );

      expect(response.statusCode).toBe(422);
      expect(mockListObjects).not.toHaveBeenCalled();
    });

    it("should return 422 for an invalid resource type", async () => {
      const response = await handler(
        createObjectApiGatewayEvent({
          rawPath: `/apps/${App.App1}/objects/InvalidType`,
          pathParameters: {
            app: App.App1,
            object: "InvalidType",
          },
        }),
        mockContext,
      );

      expect(response.statusCode).toBe(422);
      expect(mockListObjects).not.toHaveBeenCalled();
    });

    it("should handle service errors", async () => {
      mockListObjects.mockRejectedValue(new Error("Service error"));

      const response = await handler(createObjectApiGatewayEvent(), mockContext);

      expect(response.statusCode).toBe(500);
    });
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
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-02T00:00:00.000Z",
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

  describe("GET /apps/:app/objects/:object/:item/:audit", () => {
    const createDetailApiGatewayEvent = ({
      app = App.App1,
      object = ResourceType.UNKNOWN,
      item = "item-123",
      audit = "audit-456",
    }: Partial<
      Record<"app" | "object" | "item" | "audit", string>
    > = {}): APIGatewayProxyEventV2 => {
      const baseEvent = createApiGatewayEvent();
      const rawPath = `/apps/${app}/objects/${object}/${item}/${encodeURIComponent(audit)}`;

      return createApiGatewayEvent({
        routeKey: "GET /apps/{app}/objects/{object}/{item}/{audit}",
        rawPath,
        requestContext: {
          ...baseEvent.requestContext,
          routeKey: "GET /apps/{app}/objects/{object}/{item}/{audit}",
          http: {
            ...baseEvent.requestContext.http,
            path: rawPath,
          },
        },
        pathParameters: { app, object, item, audit },
      });
    };

    const notFound = {
      statusCode: 404,
      error: "NotFoundError",
      message: "Audit not found",
    };

    it("should return 404 when the audit does not exist", async () => {
      mockGetItem.mockRejectedValue(
        new AuditNotFoundError({
          app: App.App1,
          resourceType: ResourceType.UNKNOWN,
          id: "audit-456",
        }),
      );

      const response = await handler(createDetailApiGatewayEvent(), mockContext);

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body as string)).toEqual(notFound);
    });

    it("should return 404 when the audit belongs to another item", async () => {
      mockGetItem.mockResolvedValue({
        id: "audit-456",
        status: "success",
        tier: 2,
        operation: "testOp",
        target: { app: App.App1, type: ResourceType.UNKNOWN, id: "other-item" },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      });

      const response = await handler(createDetailApiGatewayEvent(), mockContext);

      expect(response.statusCode).toBe(404);
      expect(JSON.parse(response.body as string)).toEqual(notFound);
    });

    it("should match a numeric target id against the item as a string", async () => {
      const mockResponse = {
        id: "audit-456",
        status: "success",
        tier: 2,
        operation: "testOp",
        target: { app: App.App1, type: ResourceType.UNKNOWN, id: 12345 },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      };
      mockGetItem.mockResolvedValue(mockResponse);

      const response = await handler(createDetailApiGatewayEvent({ item: "12345" }), mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });

    it("should return an audit whose target has no id for any item", async () => {
      const mockResponse = {
        id: "audit-456",
        status: "success",
        tier: 2,
        operation: "testOp",
        target: { app: App.App1, type: ResourceType.UNKNOWN },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      };
      mockGetItem.mockResolvedValue(mockResponse);

      const response = await handler(createDetailApiGatewayEvent(), mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });

    it("should return the audit of a listed related-resource entry under its source path", async () => {
      // Listings return a related copy with the parent's id; its source is the parent's target
      const listed = {
        id: "audit-456",
        target: { app: App.TestApp, type: ResourceType.USER, id: "user-789" },
        source: { app: App.App1, type: ResourceType.UNKNOWN, id: "item-123" },
      };
      const mockResponse = {
        id: listed.id,
        status: "success",
        tier: 2,
        operation: "testOp",
        target: listed.source,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      };
      mockGetItem.mockResolvedValue(mockResponse);

      const response = await handler(
        createDetailApiGatewayEvent({
          app: listed.source.app,
          object: listed.source.type,
          item: listed.source.id,
          audit: listed.id,
        }),
        mockContext,
      );

      expect(mockGetItem).toHaveBeenCalledWith({
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
        id: "audit-456",
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });

    it("should return a related-resource copy under the related resource's path", async () => {
      // upsertItem stores the copy under the related resource's app and type, with it as the target
      const auditId = `audit-456#${App.TestApp}.${ResourceType.USER}#user-789`;
      const mockResponse = {
        id: auditId,
        status: "success",
        tier: 2,
        operation: "testOp",
        target: { app: App.TestApp, type: ResourceType.USER, id: "user-789" },
        source: { app: App.App1, type: ResourceType.UNKNOWN, id: "item-123" },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      };
      mockGetItem.mockResolvedValue(mockResponse);

      const response = await handler(
        createDetailApiGatewayEvent({
          app: App.TestApp,
          object: ResourceType.USER,
          item: "user-789",
          audit: auditId,
        }),
        mockContext,
      );

      expect(mockGetItem).toHaveBeenCalledWith({
        app: App.TestApp,
        resourceType: ResourceType.USER,
        id: auditId,
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });

    it("should return 500 when the lookup fails", async () => {
      mockGetItem.mockRejectedValue(new Error("DynamoDB error"));

      const response = await handler(createDetailApiGatewayEvent(), mockContext);

      expect(response.statusCode).toBe(500);
    });

    it("should return audit detail for an audit id", async () => {
      const mockResponse = {
        id: "audit-456",
        status: "fail",
        tier: 2,
        operation: "testOp",
        target: {
          app: App.App1,
          type: ResourceType.UNKNOWN,
          id: "item-123",
        },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        attempts: [{ number: 1, status: "fail", at: "2024-01-02T00:00:00.000Z" }],
        error: { message: "Handler detail error" },
        event: {
          source: "test.source",
          "detail-type": "TestEvent",
          detail: '{"id":"item-123"}',
        },
      };
      mockGetItem.mockResolvedValue(mockResponse);

      const response = await handler(createDetailApiGatewayEvent(), mockContext);

      expect(mockGetItem).toHaveBeenCalledWith({
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
        id: "audit-456",
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body as string)).toEqual(mockResponse);
    });
  });
});
