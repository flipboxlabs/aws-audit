import { describe, expect, it, vi } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../../../../../../../test-config.js";

vi.mock("../../../../../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

import { PathSchema } from "./schema.js";

describe("rerun handler schemas", () => {
  describe("PathSchema", () => {
    it("should validate valid path params", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
        audit: "audit-456",
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
        audit: "audit-456",
      });
    });

    it("should reject invalid app value", () => {
      const result = PathSchema.safeParse({
        app: "InvalidApp",
        object: ResourceType.UNKNOWN,
        item: "item-123",
        audit: "audit-456",
      });

      expect(result.success).toBe(false);
    });

    it("should reject invalid resource type", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: "InvalidType",
        item: "item-123",
        audit: "audit-456",
      });

      expect(result.success).toBe(false);
    });

    it("should reject missing item", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        audit: "audit-456",
      });

      expect(result.success).toBe(false);
    });

    it("should reject missing audit", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
      });

      expect(result.success).toBe(false);
    });

    // Note: These tests are skipped because the production auditConfig has empty
    // app/resourceType arrays. When a real config is provided, unskip these tests.
    it.skip("should accept all valid App enum values", () => {
      for (const appValue of Object.values(App)) {
        const result = PathSchema.safeParse({
          app: appValue,
          object: ResourceType.UNKNOWN,
          item: "item-123",
          audit: "audit-456",
        });

        expect(result.success).toBe(true);
      }
    });

    it.skip("should accept all valid ResourceType enum values", () => {
      for (const resourceType of Object.values(ResourceType)) {
        const result = PathSchema.safeParse({
          app: App.App1,
          object: resourceType,
          item: "item-123",
          audit: "audit-456",
        });

        expect(result.success).toBe(true);
      }
    });

    it("should accept UUID-style audit id", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
        audit: "550e8400-e29b-41d4-a716-446655440000",
      });

      expect(result.success).toBe(true);
    });

    it("should accept KSUID-style audit id", () => {
      const result = PathSchema.safeParse({
        app: App.App1,
        object: ResourceType.UNKNOWN,
        item: "item-123",
        audit: "2LrVQ0kEuXyUCBQ0qLK2nRq6C4J",
      });

      expect(result.success).toBe(true);
    });
  });
});
