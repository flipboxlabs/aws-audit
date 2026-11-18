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
        apps: { App1: ["Resource1"] },
        service: "my-service",
      });

      expect(config.service).toBe("my-service");
    });

    it("should read process.env.SERVICE lazily when not explicitly provided", () => {
      delete process.env.SERVICE;

      const config = defineAuditConfig({
        apps: { App1: ["Resource1"] },
      });

      expect(config.service).toBeUndefined();

      process.env.SERVICE = "lazy-service";

      expect(config.service).toBe("lazy-service");
    });

    it("should prefer explicit input.service over process.env.SERVICE", () => {
      process.env.SERVICE = "env-service";

      const config = defineAuditConfig({
        apps: { App1: ["Resource1"] },
        service: "explicit-service",
      });

      expect(config.service).toBe("explicit-service");
    });

    it("should reflect process.env.SERVICE changes after config creation", () => {
      delete process.env.SERVICE;

      const config = defineAuditConfig({
        apps: { App1: ["Resource1"] },
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
        apps: { App1: ["Resource"] },
      });

      expect(config.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
      expect(config.ttlSeconds).toBe(60 * 60 * 24 * 90);
    });

    it("should use custom ttlSeconds when supplied", () => {
      const customTtl = 60 * 60 * 24 * 30;
      const config = defineAuditConfig({
        apps: { App1: ["Resource"] },
        ttlSeconds: customTtl,
      });

      expect(config.ttlSeconds).toBe(customTtl);
    });

    it("should allow very short TTL for testing purposes", () => {
      const config = defineAuditConfig({
        apps: { App1: ["Resource"] },
        ttlSeconds: 3600,
      });

      expect(config.ttlSeconds).toBe(3600);
    });
  });

  describe("schemas", () => {
    const config = defineAuditConfig({
      apps: { Orders: ["Order", "Customer"], Inventory: ["Product", "Customer"] },
    });

    it("should validate app values correctly", () => {
      expect(config.schemas.app.parse("Orders")).toBe("Orders");
      expect(config.schemas.app.parse("Inventory")).toBe("Inventory");
      expect(() => config.schemas.app.parse("Invalid")).toThrow();
    });

    it("should validate a resource type of any app, once each", () => {
      expect(config.schemas.resourceType.options).toEqual(["Order", "Customer", "Product"]);
      expect(config.schemas.resourceType.parse("Product")).toBe("Product");
      expect(() => config.schemas.resourceType.parse("Invalid")).toThrow();
    });

    it("should validate a resource reference's type against its app's types", () => {
      expect(
        config.schemas.resourceReference.parse({ app: "Orders", type: "Order", id: "123" }),
      ).toEqual({ app: "Orders", type: "Order", id: "123" });
      expect(
        config.schemas.resourceReference.parse({ app: "Inventory", type: "Customer" }),
      ).toEqual({ app: "Inventory", type: "Customer" });

      expect(
        config.schemas.resourceReference.safeParse({ app: "Orders", type: "Product" }).error
          ?.issues,
      ).toEqual([
        expect.objectContaining({
          path: ["type"],
          message: 'Invalid option: expected one of "Order"|"Customer"',
        }),
      ]);
    });

    it("should report only the app when it isn't one, as its types are unknown", () => {
      expect(
        config.schemas.resourceReference.safeParse({ app: "Invalid", type: "Order" }).error?.issues,
      ).toEqual([
        expect.objectContaining({
          path: ["app"],
          message: 'Invalid option: expected one of "Orders"|"Inventory"',
        }),
      ]);
    });
  });

  describe("apps", () => {
    it("should pass through each app's resource types", () => {
      const config = defineAuditConfig({ apps: { App1: ["TypeA"], App2: ["TypeA", "TypeB"] } });

      expect(config.apps).toEqual({ App1: ["TypeA"], App2: ["TypeA", "TypeB"] });
    });

    it.each([
      [{}, "apps must list at least one app"],
      [{ App1: [] }, 'App "App1" must list at least one resource type'],
      [{ "Hub Spot": ["Contact"] }, 'App "Hub Spot" must hold only letters, digits, - and _'],
      [{ "a/b": ["Contact"] }, 'App "a/b" must hold only letters, digits, - and _'],
      [
        { HubSpot: ["Contact", ".."] },
        'Resource type ".." of app "HubSpot" must hold only letters, digits, - and _',
      ],
      [
        { HubSpot: ["Contact?"] },
        'Resource type "Contact?" of app "HubSpot" must hold only letters, digits, - and _',
      ],
    ])("should refuse %j", (apps, message) => {
      expect(() => defineAuditConfig({ apps })).toThrow(message);
    });

    it("should accept letters, digits, - and _", () => {
      expect(() =>
        defineAuditConfig({ apps: { "Hub_Spot-2": ["Contact_v2", "a-1"] } }),
      ).not.toThrow();
    });
  });
});
