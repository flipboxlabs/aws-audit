import { describe, expect, it } from "vitest";
import { App, ResourceType } from "../test-config.js";
import {
	BaseSchema,
	DateTimeObjectSchema,
	DateTimeStringSchema,
	Tier,
} from "./common.js";

const createValidTarget = () => ({
	app: App.App1,
	type: ResourceType.UNKNOWN,
	id: "resource-123",
});

describe("Tier", () => {
	it("should have correct tier values", () => {
		expect(Tier.INTERNAL).toBe(1);
		expect(Tier.INFO).toBe(2);
		expect(Tier.PUBLIC).toBe(3);
	});
});

describe("DateTimeStringSchema", () => {
	it("should accept ISO datetime string and return as-is", () => {
		const result = DateTimeStringSchema.parse("2024-01-15T10:30:00.000Z");
		expect(result).toBe("2024-01-15T10:30:00.000Z");
	});

	it("should accept Date object and convert to ISO string", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		const result = DateTimeStringSchema.parse(date);
		expect(result).toBe("2024-01-15T10:30:00.000Z");
	});

	it("should reject invalid datetime strings", () => {
		expect(() => DateTimeStringSchema.parse("not-a-date")).toThrow();
	});
});

describe("DateTimeObjectSchema", () => {
	it("should accept ISO datetime string and return Date object", () => {
		const result = DateTimeObjectSchema.parse("2024-01-15T10:30:00.000Z");
		expect(result).toBeInstanceOf(Date);
		expect(result.toISOString()).toBe("2024-01-15T10:30:00.000Z");
	});

	it("should accept Date object and return Date object", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		const result = DateTimeObjectSchema.parse(date);
		expect(result).toBeInstanceOf(Date);
		expect(result.toISOString()).toBe("2024-01-15T10:30:00.000Z");
	});

	it("should reject invalid datetime strings", () => {
		expect(() => DateTimeObjectSchema.parse("not-a-date")).toThrow();
	});
});

describe("BaseSchema", () => {
	it("should validate audit with all base fields", () => {
		const result = BaseSchema.parse({
			id: "audit-123",
			operation: "testOp",
			status: "success",
			tier: 2,
			target: createValidTarget(),
		});

		expect(result.id).toBe("audit-123");
		expect(result.operation).toBe("testOp");
	});

	it("should accept tenantId for multi-tenancy", () => {
		const result = BaseSchema.parse({
			id: "audit-123",
			tenantId: "tenant-abc",
			operation: "testOp",
			status: "success",
			tier: 2,
			target: createValidTarget(),
		});

		expect(result.tenantId).toBe("tenant-abc");
	});

	it("should allow tenantId to be undefined", () => {
		const result = BaseSchema.parse({
			id: "audit-123",
			operation: "testOp",
			status: "success",
			tier: 2,
			target: createValidTarget(),
		});

		expect(result.tenantId).toBeUndefined();
	});

	it("should transform string error by parsing JSON", () => {
		const result = BaseSchema.parse({
			id: "audit-123",
			operation: "testOp",
			status: "success",
			tier: 2,
			target: createValidTarget(),
			error: '{"message":"parsed error"}',
		});

		expect(result.error).toEqual({ message: "parsed error" });
	});

	it("should keep non-JSON string error as-is", () => {
		const result = BaseSchema.parse({
			id: "audit-123",
			operation: "testOp",
			status: "success",
			tier: 2,
			target: createValidTarget(),
			error: "plain string error",
		});

		expect(result.error).toBe("plain string error");
	});

	it("should transform Error instance", () => {
		const error = new Error("Test error");
		const result = BaseSchema.parse({
			id: "audit-123",
			operation: "testOp",
			status: "success",
			tier: 2,
			target: createValidTarget(),
			error,
		});

		expect(result.error).toHaveProperty("message", "Test error");
	});

	it("should accept record error", () => {
		const result = BaseSchema.parse({
			id: "audit-123",
			operation: "testOp",
			status: "success",
			tier: 2,
			target: createValidTarget(),
			error: { code: "ERR_001", details: "Something went wrong" },
		});

		expect(result.error).toEqual({
			code: "ERR_001",
			details: "Something went wrong",
		});
	});
});
