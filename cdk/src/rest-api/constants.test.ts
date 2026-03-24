import { describe, expect, it } from "vitest";
import { API_RESOURCE as APP_RESOURCE } from "./resources/app/constants.js";
import { API_RESOURCE as OBJECTS_RESOURCE } from "./resources/app/resources/objects/constants.js";
import { API_RESOURCE as RERUN_RESOURCE } from "./resources/app/resources/objects/resources/rerun/constants.js";
import { API_RESOURCE as TRACE_RESOURCE } from "./resources/trace/constants.js";

describe("REST API constants", () => {
	describe("trace constants", () => {
		it("should have correct RESOURCE value", () => {
			expect(TRACE_RESOURCE.RESOURCE).toBe("trace");
		});
	});

	describe("app constants", () => {
		it("should have correct RESOURCE value", () => {
			expect(APP_RESOURCE.RESOURCE).toBe("apps");
		});

		it("should have correct RESOURCE_WILDCARD value", () => {
			expect(APP_RESOURCE.RESOURCE_WILDCARD).toBe("app");
		});
	});

	describe("objects constants", () => {
		it("should have correct RESOURCE value", () => {
			expect(OBJECTS_RESOURCE.RESOURCE).toBe("objects");
		});

		it("should have correct RESOURCE_WILDCARD value", () => {
			expect(OBJECTS_RESOURCE.RESOURCE_WILDCARD).toBe("object");
		});

		it("should have correct RESOURCE_WILDCARD_ITEM value", () => {
			expect(OBJECTS_RESOURCE.RESOURCE_WILDCARD_ITEM).toBe("item");
		});

		it("should have correct RESOURCE_WILDCARD_ITEM_AUDIT value", () => {
			expect(OBJECTS_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT).toBe("audit");
		});
	});

	describe("rerun constants", () => {
		it("should have correct RESOURCE value", () => {
			expect(RERUN_RESOURCE.RESOURCE).toBe("rerun");
		});
	});
});
