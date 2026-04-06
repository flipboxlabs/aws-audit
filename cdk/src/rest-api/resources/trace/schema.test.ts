import { describe, expect, it, vi } from "vite-plus/test";
import { App, testConfig } from "../../../test-config.js";

vi.mock("../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

import { PathSchema, QuerySchema, ResponseSchema } from "./schema.js";

describe("trace handler schemas", () => {
  describe("PathSchema", () => {
    it("should validate valid path with trace id", () => {
      const result = PathSchema.safeParse({ trace: "trace-123" });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ trace: "trace-123" });
    });

    it("should reject missing trace id", () => {
      const result = PathSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("should reject non-string trace id", () => {
      const result = PathSchema.safeParse({ trace: 123 });
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

    it("should validate combined pagination and filter", () => {
      const result = QuerySchema.safeParse({
        "pagination[pageSize]": 10,
        "filter[app]": App.App1,
      });

      expect(result.success).toBe(true);
      expect(result.data?.["pagination[pageSize]"]).toBe(10);
      expect(result.data?.["filter[app]"]).toBe(App.App1);
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
            status: "success",
            tier: 2,
            operation: "test",
            target: { app: App.App1, type: "Unknown" },
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
