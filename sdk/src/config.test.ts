import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_TTL_SECONDS, defineAuditConfig } from "./config.js";

describe("defineAuditConfig", () => {
  describe("service field", () => {
    let originalService: string | undefined;

    beforeEach(() => {
      originalService = process.env.SERVICE;
    });

    afterEach(() => {
      if (originalService === undefined) {
        delete process.env.SERVICE;
      } else {
        process.env.SERVICE = originalService;
      }
    });

    it("should return explicit service from input when provided", () => {
      const config = defineAuditConfig({
        apps: ["App1"] as const,
        resourceTypes: ["Resource1"] as const,
        service: "my-service",
      });

      expect(config.service).toBe("my-service");
    });

    it("should read process.env.SERVICE lazily when not explicitly provided", () => {
      delete process.env.SERVICE;

      const config = defineAuditConfig({
        apps: ["App1"] as const,
        resourceTypes: ["Resource1"] as const,
      });

      expect(config.service).toBeUndefined();

      process.env.SERVICE = "lazy-service";

      expect(config.service).toBe("lazy-service");
    });

    it("should prefer explicit input.service over process.env.SERVICE", () => {
      process.env.SERVICE = "env-service";

      const config = defineAuditConfig({
        apps: ["App1"] as const,
        resourceTypes: ["Resource1"] as const,
        service: "explicit-service",
      });

      expect(config.service).toBe("explicit-service");
    });

    it("should reflect process.env.SERVICE changes after config creation", () => {
      delete process.env.SERVICE;

      const config = defineAuditConfig({
        apps: ["App1"] as const,
        resourceTypes: ["Resource1"] as const,
      });

      process.env.SERVICE = "v1";
      expect(config.service).toBe("v1");

      process.env.SERVICE = "v2";
      expect(config.service).toBe("v2");
    });
  });

  describe("ttlSeconds", () => {
    it("should default to 90 days in seconds when not supplied", () => {
      const config = defineAuditConfig({
        apps: ["App1"] as const,
        resourceTypes: ["Resource"] as const,
      });

      expect(config.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
      expect(config.ttlSeconds).toBe(60 * 60 * 24 * 90);
    });

    it("should use custom ttlSeconds when supplied", () => {
      const customTtl = 60 * 60 * 24 * 30;
      const config = defineAuditConfig({
        apps: ["App1"] as const,
        resourceTypes: ["Resource"] as const,
        ttlSeconds: customTtl,
      });

      expect(config.ttlSeconds).toBe(customTtl);
    });

    it("should allow very short TTL for testing purposes", () => {
      const config = defineAuditConfig({
        apps: ["App1"] as const,
        resourceTypes: ["Resource"] as const,
        ttlSeconds: 3600,
      });

      expect(config.ttlSeconds).toBe(3600);
    });
  });

  describe("schemas", () => {
    it("should validate app values correctly", () => {
      const config = defineAuditConfig({
        apps: ["Orders", "Inventory"] as const,
        resourceTypes: ["Order", "Product"] as const,
      });

      expect(config.schemas.app.parse("Orders")).toBe("Orders");
      expect(config.schemas.app.parse("Inventory")).toBe("Inventory");
      expect(() => config.schemas.app.parse("Invalid")).toThrow();
    });

    it("should validate resourceType values correctly", () => {
      const config = defineAuditConfig({
        apps: ["Orders"] as const,
        resourceTypes: ["Order", "Product"] as const,
      });

      expect(config.schemas.resourceType.parse("Order")).toBe("Order");
      expect(config.schemas.resourceType.parse("Product")).toBe("Product");
      expect(() => config.schemas.resourceType.parse("Invalid")).toThrow();
    });

    it("should validate resourceReference correctly", () => {
      const config = defineAuditConfig({
        apps: ["Orders"] as const,
        resourceTypes: ["Order"] as const,
      });

      expect(
        config.schemas.resourceReference.parse({ app: "Orders", type: "Order", id: "123" }),
      ).toEqual({ app: "Orders", type: "Order", id: "123" });

      expect(() =>
        config.schemas.resourceReference.parse({ app: "Invalid", type: "Order" }),
      ).toThrow();
    });
  });

  describe("apps and resourceTypes", () => {
    it("should pass through apps and resourceTypes from input", () => {
      const config = defineAuditConfig({
        apps: ["App1", "App2"] as const,
        resourceTypes: ["TypeA", "TypeB"] as const,
      });

      expect(config.apps).toEqual(["App1", "App2"]);
      expect(config.resourceTypes).toEqual(["TypeA", "TypeB"]);
    });
  });
});
