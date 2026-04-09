import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../../../../../test-config.js";

const { mockGetItem, mockPutEvents } = vi.hoisted(() => ({
  mockGetItem: vi.fn(),
  mockPutEvents: vi.fn(),
}));

vi.mock("../../../../../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

vi.mock("@flipboxlabs/aws-audit-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flipboxlabs/aws-audit-sdk")>();
  return {
    ...actual,
    AuditService: class MockAuditService {
      getItem = mockGetItem;
    },
    BatchHandler: class MockBatchHandler {
      putEvents = mockPutEvents;
    },
    EventBridge: {
      ...actual.EventBridge,
      Bus: {
        Name: vi.fn().mockReturnValue("test-event-bus"),
      },
    },
  };
});

vi.mock("@aws-lambda-powertools/logger", () => ({
  Logger: class MockLogger {},
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class MockEventBridgeClient {},
}));

import { handler } from "./handler.js";

const createApiGatewayEvent = (
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 =>
  ({
    version: "2.0",
    routeKey: "POST /apps/{app}/objects/{object}/{item}/{audit}/rerun",
    rawPath: `/apps/${App.App1}/objects/${ResourceType.UNKNOWN}/item-123/audit-456/rerun`,
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
        method: "POST",
        path: `/apps/${App.App1}/objects/${ResourceType.UNKNOWN}/item-123/audit-456/rerun`,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test-agent",
      },
      requestId: "request-id",
      routeKey: "POST /apps/{app}/objects/{object}/{item}/{audit}/rerun",
      stage: "$default",
      time: "01/Jan/2024:00:00:00 +0000",
      timeEpoch: 1704067200000,
    },
    pathParameters: {
      app: App.App1,
      object: ResourceType.UNKNOWN,
      item: "item-123",
      audit: "audit-456",
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

describe("rerun handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("POST /apps/:app/objects/:object/:item/:audit/rerun", () => {
    it("should rerun a rerunable audit event", async () => {
      const mockAuditItem = {
        id: "audit-456",
        rerunable: true,
        event: {
          source: "test-source",
          "detail-type": "TestEvent",
          detail: { key: "value" },
        },
      };
      mockGetItem.mockResolvedValue(mockAuditItem);
      mockPutEvents.mockResolvedValue({});

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(mockGetItem).toHaveBeenCalledWith({
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
        id: "audit-456",
      });
      expect(mockPutEvents).toHaveBeenCalledWith([
        {
          Source: "test-source",
          EventBusName: "test-event-bus",
          Detail: JSON.stringify({ key: "value" }),
          DetailType: "TestEvent",
        },
      ]);
      expect(response.statusCode).toBe(204);
    });

    it("should return 400 when item is not rerunable", async () => {
      const mockAuditItem = {
        id: "audit-456",
        rerunable: false,
        event: {
          source: "test-source",
          "detail-type": "TestEvent",
          detail: {},
        },
      };
      mockGetItem.mockResolvedValue(mockAuditItem);

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(mockGetItem).toHaveBeenCalled();
      expect(mockPutEvents).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 when item has no event", async () => {
      const mockAuditItem = {
        id: "audit-456",
        rerunable: true,
        event: null,
      };
      mockGetItem.mockResolvedValue(mockAuditItem);

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(mockGetItem).toHaveBeenCalled();
      expect(mockPutEvents).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(400);
    });

    it("should return 422 for invalid app parameter", async () => {
      const event = createApiGatewayEvent({
        rawPath: `/apps/InvalidApp/objects/${ResourceType.UNKNOWN}/item-123/audit-456/rerun`,
        pathParameters: {
          app: "InvalidApp",
          object: ResourceType.UNKNOWN,
          item: "item-123",
          audit: "audit-456",
        },
      });
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(422);
      expect(mockGetItem).not.toHaveBeenCalled();
    });

    it("should return 422 for invalid resource type", async () => {
      const event = createApiGatewayEvent({
        rawPath: `/apps/${App.App1}/objects/InvalidType/item-123/audit-456/rerun`,
        pathParameters: {
          app: App.App1,
          object: "InvalidType",
          item: "item-123",
          audit: "audit-456",
        },
      });
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(422);
      expect(mockGetItem).not.toHaveBeenCalled();
    });

    it("should handle service errors when getting item", async () => {
      mockGetItem.mockRejectedValue(new Error("Service error"));

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(500);
    });

    it("should handle EventBridge errors", async () => {
      const mockAuditItem = {
        id: "audit-456",
        rerunable: true,
        event: {
          source: "test-source",
          "detail-type": "TestEvent",
          detail: {},
        },
      };
      mockGetItem.mockResolvedValue(mockAuditItem);
      mockPutEvents.mockRejectedValue(new Error("EventBridge error"));

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(500);
    });
  });
});
