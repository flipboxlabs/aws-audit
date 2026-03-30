import { describe, expect, it } from "vitest";
import { App, ResourceType } from "../test-config.js";
import {
	AuditListItemPayloadSchema,
	AuditPayloadSchema,
	AuditSchema,
} from "./audit.js";
import { BaseSchema } from "./common.js";

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
});

describe("AuditPayloadSchema", () => {
	it("should be same as BaseSchema", () => {
		expect(AuditPayloadSchema).toBe(BaseSchema);
	});
});

describe("AuditListItemPayloadSchema", () => {
	it("should be same as BaseSchema", () => {
		expect(AuditListItemPayloadSchema).toBe(BaseSchema);
	});
});
