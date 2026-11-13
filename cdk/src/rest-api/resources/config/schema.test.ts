import { describe, expect, it, vi } from "vitest";
import { App, ResourceType, testConfig } from "../../../test-config.js";

vi.mock("../../../audit-config.js", () => ({
  auditConfig: testConfig,
}));

import { ResponseSchema } from "./schema.js";

const validResponse = {
  apps: [App.App1, App.TestApp],
  resourceTypes: [ResourceType.UNKNOWN, ResourceType.USER, ResourceType.ORDER],
  statuses: ["success", "warn", "fail", "skip"],
  version: "1.6.0",
};

describe("config handler schemas", () => {
  describe("ResponseSchema", () => {
    it("should validate a valid response", () => {
      const result = ResponseSchema.safeParse(validResponse);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(validResponse);
    });

    it("should preserve the order of apps and resource types", () => {
      const result = ResponseSchema.safeParse({
        ...validResponse,
        apps: [App.TestApp, App.App1],
        resourceTypes: [ResourceType.ORDER, ResourceType.UNKNOWN],
      });

      expect(result.success).toBe(true);
      expect(result.data?.apps).toEqual([App.TestApp, App.App1]);
      expect(result.data?.resourceTypes).toEqual([ResourceType.ORDER, ResourceType.UNKNOWN]);
    });

    it("should reject an unknown app", () => {
      const result = ResponseSchema.safeParse({ ...validResponse, apps: ["InvalidApp"] });
      expect(result.success).toBe(false);
    });

    it("should reject an unknown resource type", () => {
      const result = ResponseSchema.safeParse({
        ...validResponse,
        resourceTypes: ["InvalidType"],
      });
      expect(result.success).toBe(false);
    });

    it("should reject an unknown status", () => {
      const result = ResponseSchema.safeParse({ ...validResponse, statuses: ["invalid-status"] });
      expect(result.success).toBe(false);
    });

    it("should reject a missing version", () => {
      const { version: _version, ...response } = validResponse;
      const result = ResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });

    it("should reject an empty version", () => {
      const result = ResponseSchema.safeParse({ ...validResponse, version: "" });
      expect(result.success).toBe(false);
    });
  });
});
