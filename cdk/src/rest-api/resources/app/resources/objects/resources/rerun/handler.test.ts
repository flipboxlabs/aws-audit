import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../../../../../test-config.js";

const { mockGetItem, mockPutEventsOrThrow, mockLogError } = vi.hoisted(() => ({
  mockGetItem: vi.fn(),
  mockPutEventsOrThrow: vi.fn(),
  mockLogError: vi.fn(),
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
      putEventsOrThrow = mockPutEventsOrThrow;
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
  Logger: class MockLogger {
    error = mockLogError;
  },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class MockEventBridgeClient {},
}));

import { EventBridgeEventSchema, PutEventsError } from "@flipboxlabs/aws-audit-sdk";
import { handler } from "./handler.js";

// Shape `event` the way getItem returns it: parsed through the real schema, which stores detail as a JSON string
const storedEvent = (detail: string | Record<string, unknown>) =>
  EventBridgeEventSchema.parse({ source: "test-source", "detail-type": "TestEvent", detail });

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
        event: storedEvent({ k: 1 }),
      };
      mockGetItem.mockResolvedValue(mockAuditItem);
      mockPutEventsOrThrow.mockResolvedValue([{ EventId: "event-1" }]);

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(mockGetItem).toHaveBeenCalledWith({
        app: App.App1,
        resourceType: ResourceType.UNKNOWN,
        id: "audit-456",
      });
      expect(mockPutEventsOrThrow).toHaveBeenCalledWith([
        {
          Source: "test-source",
          EventBusName: "test-event-bus",
          Detail: '{"k":1}',
          DetailType: "TestEvent",
        },
      ]);
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    });

    it("should return 400 when item is not rerunable", async () => {
      const mockAuditItem = {
        id: "audit-456",
        rerunable: false,
        event: storedEvent({}),
      };
      mockGetItem.mockResolvedValue(mockAuditItem);

      const event = createApiGatewayEvent();
      const response = await handler(event, mockContext);

      expect(mockGetItem).toHaveBeenCalled();
      expect(mockPutEventsOrThrow).not.toHaveBeenCalled();
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
      expect(mockPutEventsOrThrow).not.toHaveBeenCalled();
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

    describe("when the event is not re-sent", () => {
      const rerunError = {
        statusCode: 500,
        error: "InternalServerError",
        message: "Unable to rerun the event",
      };

      beforeEach(() => {
        mockGetItem.mockResolvedValue({
          id: "audit-456",
          rerunable: true,
          event: storedEvent({}),
        });
      });

      it("should return 500 when PutEvents throws", async () => {
        const cause = new Error("AccessDeniedException");
        const error = new PutEventsError("Error pushing event bridge events", [], { cause });
        mockPutEventsOrThrow.mockRejectedValue(error);

        const response = await handler(createApiGatewayEvent(), mockContext);

        expect(response.statusCode).toBe(500);
        expect(JSON.parse(response.body)).toEqual(rerunError);
        expect(mockLogError).toHaveBeenCalledWith("Unable to rerun the event", error);
      });

      it("should return 500 when EventBridge rejects the entry", async () => {
        const failedEntries = [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }];
        const error = new PutEventsError("EventBridge accepted 0 of 1 events", failedEntries);
        mockPutEventsOrThrow.mockRejectedValue(error);

        const response = await handler(createApiGatewayEvent(), mockContext);

        expect(response.statusCode).toBe(500);
        expect(JSON.parse(response.body)).toEqual(rerunError);
        expect(mockLogError).toHaveBeenCalledWith("Unable to rerun the event", error);
      });
    });
  });
});
