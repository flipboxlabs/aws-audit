import { describe, expect, it } from "vite-plus/test";
import { AuditNotFoundError } from "./errors.js";
import { App, ResourceType } from "./test-config.js";

describe("AuditNotFoundError", () => {
  it("should keep its own copy of the identifiers", () => {
    const identifiers = {
      id: "audit-123",
      app: App.App1,
      resourceType: ResourceType.UNKNOWN,
    };
    const error = new AuditNotFoundError(identifiers);

    identifiers.id = "audit-456";

    expect(error.identifiers).toEqual({
      id: "audit-123",
      app: App.App1,
      resourceType: ResourceType.UNKNOWN,
    });
    expect(error.identifiers).not.toBe(identifiers);
  });
});
