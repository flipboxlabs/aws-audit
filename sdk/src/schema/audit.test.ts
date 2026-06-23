import { describe, expect, it } from "vite-plus/test";
import { App, ResourceType } from "../test-config.js";
import { AuditPayloadSchema, AuditSchema } from "./audit.js";

const createValidTarget = () => ({
  app: App.App1,
  type: ResourceType.UNKNOWN,
  id: "resource-123",
});

describe("AuditSchema", () => {
  it("should transform ISO timestamps to Date objects", () => {
    const result = AuditSchema.parse({
      id: "audit-123",
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
      updatedAt: "2024-01-15T10:30:00.000Z",
      createdAt: "2024-01-15T10:30:00.000Z",
    });

    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("should require timestamps", () => {
    expect(() =>
      AuditSchema.parse({
        id: "audit-123",
        operation: "testOp",
        status: "success",
        tier: 2,
        target: createValidTarget(),
      }),
    ).toThrow();
  });

  it("should accept Date objects for timestamps", () => {
    const date = new Date("2024-01-15T10:30:00.000Z");
    const result = AuditSchema.parse({
      id: "audit-123",
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
      updatedAt: date,
      createdAt: date,
    });

    expect(result.updatedAt).toBeInstanceOf(Date);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("should convert null messages from stored audit items to undefined", () => {
    const result = AuditSchema.parse({
      id: "audit-123",
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
      message: null,
      updatedAt: "2024-01-15T10:30:00.000Z",
      createdAt: "2024-01-15T10:30:00.000Z",
    });

    expect(result.message).toBeUndefined();
  });
});

describe("AuditPayloadSchema", () => {
  it("should accept JSON response timestamps", () => {
    const result = AuditPayloadSchema.parse({
      id: "audit-123",
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
      updatedAt: "2024-01-15T10:30:00.000Z",
      createdAt: "2024-01-15T10:30:00.000Z",
      error: { message: "Payload error" },
      attempts: [{ number: 1, status: "fail", at: "2024-01-15T10:30:00.000Z" }],
      event: {
        source: "test.source",
        "detail-type": "TestEvent",
        detail: '{"id":"item-123"}',
      },
    });

    expect(result.updatedAt).toBe("2024-01-15T10:30:00.000Z");
    expect(result.createdAt).toBe("2024-01-15T10:30:00.000Z");
    expect(result.error).toEqual({ message: "Payload error" });
    expect(result.attempts).toEqual([
      { number: 1, status: "fail", at: "2024-01-15T10:30:00.000Z" },
    ]);
    expect(result.event).toEqual({
      source: "test.source",
      "detail-type": "TestEvent",
      detail: '{"id":"item-123"}',
    });
  });

  it("should convert null messages in JSON response payloads to undefined", () => {
    const result = AuditPayloadSchema.parse({
      id: "audit-123",
      operation: "testOp",
      status: "success",
      tier: 2,
      target: createValidTarget(),
      message: null,
    });

    expect(result.message).toBeUndefined();
  });
});
