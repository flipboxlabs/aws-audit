import { describe, expect, it } from "vite-plus/test";
import { App, ResourceType, testConfig } from "../test-config.js";
import { createTypedLogAuditSchema, Status } from "./log.js";

const LogAuditSchema = createTypedLogAuditSchema(testConfig.schemas.resourceReference);

const createValidTarget = () => ({
  app: App.App1,
  type: ResourceType.UNKNOWN,
  id: "resource-123",
});

describe("Status", () => {
  it("should have correct status values", () => {
    expect(Status.SUCCESS).toBe("success");
    expect(Status.WARN).toBe("warn");
    expect(Status.FAIL).toBe("fail");
    expect(Status.SKIP).toBe("skip");
  });
});

describe("LogAuditSchema", () => {
  it("should validate minimal audit", () => {
    const result = LogAuditSchema.parse({
      operation: "testOp",
      target: createValidTarget(),
    });

    expect(result.operation).toBe("testOp");
    expect(result.tier).toBe(2); // default
    expect(result.status).toBe("success"); // default
  });

  it("should accept tenantId for multi-tenancy", () => {
    const result = LogAuditSchema.parse({
      operation: "testOp",
      tenantId: "tnt-123",
      target: createValidTarget(),
    });

    expect(result.tenantId).toBe("tnt-123");
  });

  it("should allow tenantId to be undefined", () => {
    const result = LogAuditSchema.parse({
      operation: "testOp",
      target: createValidTarget(),
    });

    expect(result.tenantId).toBeUndefined();
  });

  it("should accept all fields", () => {
    const result = LogAuditSchema.parse({
      operation: "testOp",
      tenantId: "tenant-456",
      tier: 3,
      status: "fail",
      target: createValidTarget(),
      source: createValidTarget(),
      context: { key: "value" },
      message: "Test message",
      trace: "trace-123",
      event: { source: "test" },
    });

    expect(result.tenantId).toBe("tenant-456");
    expect(result.tier).toBe(3);
    expect(result.status).toBe("fail");
    expect(result.source).toBeDefined();
    expect(result.context).toEqual({ key: "value" });
  });

  it("should transform Error to JSON string", () => {
    const error = new Error("Test error");
    const result = LogAuditSchema.parse({
      operation: "testOp",
      target: createValidTarget(),
      error,
    });

    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("Test error");
  });

  it("should keep string error as-is", () => {
    const result = LogAuditSchema.parse({
      operation: "testOp",
      target: createValidTarget(),
      error: "String error",
    });

    expect(result.error).toBe("String error");
  });

  it("should convert Set to Array for resources", () => {
    const resources = new Set([
      { app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" },
      { app: App.App1, type: ResourceType.UNKNOWN, id: "res-2" },
    ]);

    const result = LogAuditSchema.parse({
      operation: "testOp",
      target: createValidTarget(),
      resources,
    });

    expect(Array.isArray(result.resources)).toBe(true);
    expect(result.resources).toHaveLength(2);
  });

  it("should accept Array for resources", () => {
    const result = LogAuditSchema.parse({
      operation: "testOp",
      target: createValidTarget(),
      resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
    });

    expect(result.resources).toHaveLength(1);
  });

  it("should validate nested context values", () => {
    const result = LogAuditSchema.parse({
      operation: "testOp",
      target: createValidTarget(),
      context: {
        string: "value",
        number: 123,
        boolean: true,
        nested: {
          deep: {
            value: "works",
          },
        },
      },
    });

    expect(result.context?.nested).toEqual({ deep: { value: "works" } });
  });

  it("should reject invalid tier", () => {
    expect(() =>
      LogAuditSchema.parse({
        operation: "testOp",
        target: createValidTarget(),
        tier: 5,
      }),
    ).toThrow();
  });

  it("should reject invalid status", () => {
    expect(() =>
      LogAuditSchema.parse({
        operation: "testOp",
        target: createValidTarget(),
        status: "invalid",
      }),
    ).toThrow();
  });
});
