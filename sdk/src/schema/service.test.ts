import { describe, expect, it } from "vitest";
import { App, ResourceType } from "../test-config.js";
import { UpsertAuditSchema } from "./service.js";

const createValidTarget = () => ({
	app: App.App1,
	type: ResourceType.UNKNOWN,
	id: "resource-123",
});

describe("UpsertAuditSchema", () => {
	it("should extend LogAuditSchema with id and rerunable", () => {
		const result = UpsertAuditSchema.parse({
			id: "audit-123",
			operation: "testOp",
			target: createValidTarget(),
			rerunable: true,
		});

		expect(result.id).toBe("audit-123");
		expect(result.rerunable).toBe(true);
	});

	it("should allow optional id", () => {
		const result = UpsertAuditSchema.parse({
			operation: "testOp",
			target: createValidTarget(),
		});

		expect(result.id).toBeUndefined();
	});

	it("should allow optional rerunable", () => {
		const result = UpsertAuditSchema.parse({
			operation: "testOp",
			target: createValidTarget(),
		});

		expect(result.rerunable).toBeUndefined();
	});

	it("should inherit all LogAuditSchema fields", () => {
		const result = UpsertAuditSchema.parse({
			operation: "testOp",
			tier: 3,
			status: "warn",
			target: createValidTarget(),
			source: createValidTarget(),
			message: "Test",
			trace: "trace-123",
		});

		expect(result.tier).toBe(3);
		expect(result.status).toBe("warn");
		expect(result.message).toBe("Test");
	});

	it("should accept attempts array", () => {
		const result = UpsertAuditSchema.parse({
			operation: "testOp",
			target: createValidTarget(),
			attempts: [
				{ number: 1, status: "fail", at: "2024-01-15T10:30:00.000Z" },
				{ number: 2, status: "success", at: "2024-01-15T10:31:00.000Z" },
			],
		});

		expect(result.attempts).toHaveLength(2);
		expect(result.attempts?.[0].number).toBe(1);
		expect(result.attempts?.[1].status).toBe("success");
	});

	it("should accept createdAt timestamp", () => {
		const result = UpsertAuditSchema.parse({
			operation: "testOp",
			target: createValidTarget(),
			createdAt: "2024-01-15T10:30:00.000Z",
		});

		expect(result.createdAt).toBe("2024-01-15T10:30:00.000Z");
	});

	it("should convert Date createdAt to ISO string", () => {
		const date = new Date("2024-01-15T10:30:00.000Z");
		const result = UpsertAuditSchema.parse({
			operation: "testOp",
			target: createValidTarget(),
			createdAt: date,
		});

		expect(result.createdAt).toBe("2024-01-15T10:30:00.000Z");
	});
});
