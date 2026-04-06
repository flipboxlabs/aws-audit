import { describe, expect, it } from "vite-plus/test";
import { App, ResourceType } from "../test-config.js";
import { AuditStorageSchema } from "./storage.js";

const createValidTarget = () => ({
  app: App.App1,
  type: ResourceType.UNKNOWN,
  id: "resource-123",
});

describe("AuditStorageSchema", () => {
  it("should auto-generate id if not provided", () => {
    const result = AuditStorageSchema.parse({
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
    });

    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");
  });

  it("should use provided id", () => {
    const result = AuditStorageSchema.parse({
      id: "custom-id",
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
    });

    expect(result.id).toBe("custom-id");
  });

  it("should default timestamps to current time", () => {
    const result = AuditStorageSchema.parse({
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
    });

    expect(result.updatedAt).toBeDefined();
    expect(result.createdAt).toBeDefined();

    // Verify timestamps are valid ISO strings that can be parsed as dates
    const updatedAt = new Date(result.updatedAt);
    const createdAt = new Date(result.createdAt);
    expect(updatedAt.getTime()).not.toBeNaN();
    expect(createdAt.getTime()).not.toBeNaN();

    // Verify timestamps are recent (within last second)
    const now = Date.now();
    expect(now - updatedAt.getTime()).toBeLessThan(1000);
    expect(now - createdAt.getTime()).toBeLessThan(1000);
  });

  it("should convert Date to ISO string", () => {
    const date = new Date("2024-01-15T10:30:00.000Z");
    const result = AuditStorageSchema.parse({
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
      updatedAt: date,
      createdAt: date,
    });

    expect(result.updatedAt).toBe("2024-01-15T10:30:00.000Z");
    expect(result.createdAt).toBe("2024-01-15T10:30:00.000Z");
  });

  it("should keep ISO string as-is", () => {
    const result = AuditStorageSchema.parse({
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
      updatedAt: "2024-01-15T10:30:00.000Z",
      createdAt: "2024-01-15T10:30:00.000Z",
    });

    expect(result.updatedAt).toBe("2024-01-15T10:30:00.000Z");
    expect(result.createdAt).toBe("2024-01-15T10:30:00.000Z");
  });
});
