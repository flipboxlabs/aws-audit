import { describe, expect, it, vi } from "vitest";
import { App, ResourceType, testConfig } from "../../../test-config.js";

vi.mock("../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

import { PathSchema, QuerySchema, ResponseSchema } from "./schema.js";

describe("status handler schemas", () => {
  describe("PathSchema", () => {
    it("should validate valid status: success", () => {
      const result = PathSchema.safeParse({ status: "success" });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ status: "success" });
    });

    it("should validate valid status: fail", () => {
      const result = PathSchema.safeParse({ status: "fail" });
      expect(result.success).toBe(true);
    });

    it("should validate valid status: warn", () => {
      const result = PathSchema.safeParse({ status: "warn" });
      expect(result.success).toBe(true);
    });

    it("should validate valid status: skip", () => {
      const result = PathSchema.safeParse({ status: "skip" });
      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const result = PathSchema.safeParse({ status: "invalid-status" });
      expect(result.success).toBe(false);
    });

    it("should reject missing status", () => {
      const result = PathSchema.safeParse({});
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
        "pagination[pageSize]": "50",
      });

      expect(result.success).toBe(true);
      expect(result.data?.["pagination[pageSize]"]).toBe(50);
    });

    it("should validate filter with valid app", () => {
      const result = QuerySchema.safeParse({
        "filter[app]": App.App1,
      });

      expect(result.success).toBe(true);
      expect(result.data?.["filter[app]"]).toBe(App.App1);
    });

    it("should reject filter with invalid app", () => {
      const result = QuerySchema.safeParse({
        "filter[app]": "InvalidApp",
      });

      expect(result.success).toBe(false);
    });

    it("should validate filter with valid resourceType", () => {
      const result = QuerySchema.safeParse({
        "filter[resourceType]": ResourceType.USER,
      });

      expect(result.success).toBe(true);
      expect(result.data?.["filter[resourceType]"]).toBe(ResourceType.USER);
    });

    it("should reject filter with invalid resourceType", () => {
      const result = QuerySchema.safeParse({
        "filter[resourceType]": "InvalidType",
      });

      expect(result.success).toBe(false);
    });

    it("should validate combined pagination and filters", () => {
      const result = QuerySchema.safeParse({
        "pagination[pageSize]": 10,
        "filter[app]": App.App1,
        "filter[resourceType]": ResourceType.ORDER,
      });

      expect(result.success).toBe(true);
      expect(result.data?.["pagination[pageSize]"]).toBe(10);
      expect(result.data?.["filter[app]"]).toBe(App.App1);
      expect(result.data?.["filter[resourceType]"]).toBe(ResourceType.ORDER);
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
            id: "audit-123",
            status: "fail",
            tier: 2,
            operation: "testOp",
            target: { app: App.App1, type: ResourceType.UNKNOWN },
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it("should validate response with pagination", () => {
      const result = ResponseSchema.safeParse({
        items: [],
        pagination: { nextToken: "next-page-token" },
      });

      expect(result.success).toBe(true);
      expect(result.data?.pagination?.nextToken).toBe("next-page-token");
    });

    it("should reject response without items array", () => {
      const result = ResponseSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
