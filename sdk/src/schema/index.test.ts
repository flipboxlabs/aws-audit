import { describe, expect, it } from "vitest";
import { App, ResourceType } from "../test-config.js";

const createValidTarget = () => ({
	app: App.App1,
	type: ResourceType.UNKNOWN,
	id: "resource-123",
});

describe("schema/index.ts exports", () => {
	it("should export all audit schemas", async () => {
		const index = await import("./index.js");

		expect(index.AuditSchema).toBeDefined();
		expect(index.AuditPayloadSchema).toBeDefined();
		expect(index.AuditListItemPayloadSchema).toBeDefined();
	});

	it("should export common types and Tier", async () => {
		const index = await import("./index.js");

		expect(index.Tier).toBeDefined();
		expect(index.Tier.INTERNAL).toBe(1);
		expect(index.Tier.INFO).toBe(2);
		expect(index.Tier.PUBLIC).toBe(3);
	});

	it("should export log schemas and Status", async () => {
		const index = await import("./index.js");

		expect(index.LogAuditSchema).toBeDefined();
		expect(index.Status).toBeDefined();
		expect(index.Status.SUCCESS).toBe("success");
		expect(index.Status.FAIL).toBe("fail");
	});

	it("should export model schemas", async () => {
		const index = await import("./index.js");

		expect(index.EventBridgeEventSchema).toBeDefined();
		expect(index.PaginationSchema).toBeDefined();
		expect(index.CollectionSchema).toBeDefined();
		expect(index.PaginationCollectionSchema).toBeDefined();
	});

	it("should export service schemas", async () => {
		const index = await import("./index.js");

		expect(index.UpsertAuditSchema).toBeDefined();
	});

	it("should export storage schemas", async () => {
		const index = await import("./index.js");

		expect(index.AuditStorageSchema).toBeDefined();
	});

	it("should have functional schemas from index exports", async () => {
		const index = await import("./index.js");

		// Verify schemas work when imported from index
		const result = index.LogAuditSchema.parse({
			operation: "testOp",
			target: createValidTarget(),
		});

		expect(result.operation).toBe("testOp");
		expect(result.status).toBe("success");
	});
});
