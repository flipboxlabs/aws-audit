import { describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../../../test-config.js";

vi.mock("../../../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

import { PathSchema, QuerySchema, ResponseSchema } from "./schema.js";

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

  describe("ResponseSchema", () => {
    it("should validate valid response with empty items", () => {
      const result = ResponseSchema.safeParse({ items: [] });
      expect(result.success).toBe(true);
    });

    it("should validate valid response with audit items", () => {
      const result = ResponseSchema.safeParse({
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
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it("should validate response with pagination", () => {
      const result = ResponseSchema.safeParse({
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
      const result = ResponseSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("should reject invalid audit item status", () => {
      const result = ResponseSchema.safeParse({
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
});
