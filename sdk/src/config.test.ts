import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_TTL_SECONDS, defineAuditConfig } from "./config.js";

describe("defineAuditConfig", () => {
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
      const customTtl = 60 * 60 * 24 * 30; // 30 days
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
        ttlSeconds: 3600, // 1 hour
      });

      expect(config.ttlSeconds).toBe(3600);
    });
  });

  describe("apps and resourceTypes", () => {
    it("should preserve apps and resourceTypes from input", () => {
      const config = defineAuditConfig({
        apps: ["App1", "App2"] as const,
        resourceTypes: ["User", "Order"] as const,
      });

      expect(config.apps).toEqual(["App1", "App2"]);
      expect(config.resourceTypes).toEqual(["User", "Order"]);
    });

    it("should create valid schemas for apps", () => {
      const config = defineAuditConfig({
        apps: ["App1", "App2"] as const,
        resourceTypes: ["User"] as const,
      });

      expect(() => config.schemas.app.parse("App1")).not.toThrow();
      expect(() => config.schemas.app.parse("Invalid")).toThrow();
    });
  });
});
