import { describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../../../test-config.js";

vi.mock("../../../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

import {
  DetailPathSchema,
  ResponseDetailSchema,
  PathSchema,
  QuerySchema,
  ResponseCollectionSchema,
} from "./schema.js";

describe("objects handler schemas", () => {
  describe("PathSchema", () => {
    it("should validate valid path params", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
      });
    });

    it("should reject invalid app value", () => {
      const result = PathSchema.safeParse({
        app: "InvalidApp",
        object: ResourceType.UNKNOWN,
        item: "item-123",
      });

      expect(result.success).toBe(false);
    });

    it("should reject invalid resource type", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: "InvalidType",
        item: "item-123",
      });

      expect(result.success).toBe(false);
    });

    it("should reject missing item", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
      });

      expect(result.success).toBe(false);
    });

    it("should accept numeric string as item id", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "12345",
      });

      expect(result.success).toBe(true);
      expect(result.data?.item).toBe("12345");
    });
  });

  describe("DetailPathSchema", () => {
    it("should validate valid detail path params", () => {
      const result = DetailPathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
        audit: "audit-456",
      });

      expect(result.success).toBe(true);
      expect(result.data?.audit).toBe("audit-456");
    });

    it("should reject missing audit id", () => {
      const result = DetailPathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("QuerySchema", () => {
    it("should validate empty query params", () => {
      const result = QuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
    });

    it("should validate pagination params", () => {
      const result = QuerySchema.safeParse({
        "pagination[pageSize]": "25",
        "pagination[nextToken]": "abc123",
      });

      expect(result.success).toBe(true);
      expect(result.data?.["pagination[pageSize]"]).toBe(25);
      expect(result.data?.["pagination[nextToken]"]).toBe("abc123");
    });

    it("should coerce pageSize from string to number", () => {
      const result = QuerySchema.safeParse({
        "pagination[pageSize]": "100",
      });

      expect(result.success).toBe(true);
      expect(result.data?.["pagination[pageSize]"]).toBe(100);
    });

    it("should allow pagination with only nextToken", () => {
      const result = QuerySchema.safeParse({
        "pagination[nextToken]": "token-xyz",
      });

      expect(result.success).toBe(true);
      expect(result.data?.["pagination[nextToken]"]).toBe("token-xyz");
      expect(result.data?.["pagination[pageSize]"]).toBeUndefined();
    });
  });

  describe("ResponseCollectionSchema", () => {
    it("should validate valid response with empty items", () => {
      const result = ResponseCollectionSchema.safeParse({ items: [] });
      expect(result.success).toBe(true);
    });

    it("should validate valid response with audit items", () => {
      const result = ResponseCollectionSchema.safeParse({
        items: [
          {
            id: "audit-456",
            status: "success",
            tier: 2,
            operation: "createItem",
            target: {
              app: App.App1,
              type: ResourceType.UNKNOWN,
              id: "item-123",
            },
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-02T00:00:00.000Z",
            attempts: [{ number: 1, status: "success", at: "2024-01-02T00:00:00.000Z" }],
            error: { message: "Schema response error" },
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data?.items[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
      expect(result.data?.items[0].updatedAt).toBe("2024-01-02T00:00:00.000Z");
      expect(result.data?.items[0].attempts).toEqual([
        { number: 1, status: "success", at: "2024-01-02T00:00:00.000Z" },
      ]);
      expect(result.data?.items[0].error).toEqual({ message: "Schema response error" });
    });

    it("should validate response with pagination", () => {
      const result = ResponseCollectionSchema.safeParse({
        items: [],
        pagination: {
          pageSize: 25,
          nextToken: "next-page",
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.pagination?.pageSize).toBe(25);
      expect(result.data?.pagination?.nextToken).toBe("next-page");
    });

    it("should reject response without items array", () => {
      const result = ResponseCollectionSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("should reject invalid audit item status", () => {
      const result = ResponseCollectionSchema.safeParse({
        items: [
          {
            id: "audit-789",
            status: "invalid-status",
            tier: 2,
            operation: "test",
            target: { app: App.App1, type: ResourceType.UNKNOWN },
          },
        ],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("DetailResponseSchema", () => {
    it("should validate detail response with attempts, error, and event", () => {
      const result = ResponseDetailSchema.safeParse({
        id: "audit-456",
        status: "fail",
        tier: 2,
        operation: "createItem",
        target: {
          app: App.App1,
          type: ResourceType.UNKNOWN,
          id: "item-123",
        },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        attempts: [{ number: 1, status: "fail", at: "2024-01-02T00:00:00.000Z" }],
        error: { message: "Schema detail error" },
        event: {
          source: "test.source",
          "detail-type": "TestEvent",
          detail: '{"id":"item-123"}',
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.attempts).toEqual([
        { number: 1, status: "fail", at: "2024-01-02T00:00:00.000Z" },
      ]);
      expect(result.data?.error).toEqual({ message: "Schema detail error" });
      expect(result.data?.event).toEqual({
        source: "test.source",
        "detail-type": "TestEvent",
        detail: '{"id":"item-123"}',
      });
    });
  });
});
