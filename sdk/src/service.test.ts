import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Audit } from "./schema/audit.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { AuditService } from "./service.js";
import { App, ResourceType, testConfig } from "./test-config.js";

// Mock the repository
vi.mock("./repository.js", () => ({
	AuditRepository: vi.fn().mockImplementation(() => ({
		getItem: vi.fn(),
		upsertBatch: vi.fn(),
		listItems: vi.fn(),
		listTraceItems: vi.fn(),
	})),
}));

// Mock the eventbridge
vi.mock("./eventbridge.js", () => ({
	AuditEventBus: vi.fn().mockImplementation(() => ({
		upserted: vi.fn(),
	})),
}));

describe("AuditService", () => {
	let service: AuditService<typeof testConfig>;
	let mockLogger: {
		error: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
	};
	let mockStorage: {
		getItem: ReturnType<typeof vi.fn>;
		upsertBatch: ReturnType<typeof vi.fn>;
		listItems: ReturnType<typeof vi.fn>;
		listTraceItems: ReturnType<typeof vi.fn>;
	};
	let mockEvents: {
		upserted: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();

		mockLogger = {
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};

		mockStorage = {
			getItem: vi.fn(),
			upsertBatch: vi.fn(),
			listItems: vi.fn(),
			listTraceItems: vi.fn(),
		};

		mockEvents = {
			upserted: vi.fn(),
		};

		service = new AuditService(
			mockLogger as unknown as ConstructorParameters<
				typeof AuditService<typeof testConfig>
			>[0],
			testConfig,
			mockStorage as unknown as ConstructorParameters<
				typeof AuditService<typeof testConfig>
			>[2],
			mockEvents as unknown as ConstructorParameters<
				typeof AuditService<typeof testConfig>
			>[3],
		);
	});

	describe("constructor", () => {
		it("should create an instance with provided dependencies", () => {
			expect(service).toBeInstanceOf(AuditService);
			expect(service.events).toBe(mockEvents);
		});

		it("should allow null events", () => {
			const serviceWithoutEvents = new AuditService(
				mockLogger as unknown as ConstructorParameters<
					typeof AuditService<typeof testConfig>
				>[0],
				testConfig,
				mockStorage as unknown as ConstructorParameters<
					typeof AuditService<typeof testConfig>
				>[2],
				null,
			);

			expect(serviceWithoutEvents.events).toBeNull();
		});

		it("should allow undefined events when explicitly passed", () => {
			const serviceWithUndefined = new AuditService(
				mockLogger as unknown as ConstructorParameters<
					typeof AuditService<typeof testConfig>
				>[0],
				testConfig,
				mockStorage as unknown as ConstructorParameters<
					typeof AuditService<typeof testConfig>
				>[2],
				undefined,
			);

			// When explicitly passing undefined, the default value still kicks in
			// This tests that the code handles the default correctly
			expect(serviceWithUndefined.events).toBeDefined();
		});
	});

	describe("getItem", () => {
		const mockAudit: Audit = {
			id: "audit-123",
			operation: "testOperation",
			status: "success",
			tier: 2,
			target: {
				app: App.App1,
				type: ResourceType.UNKNOWN,
				id: "resource-123",
			},
			updatedAt: undefined,
			createdAt: undefined,
		};

		it("should return an audit when found", async () => {
			mockStorage.getItem.mockResolvedValue(mockAudit);

			const result = await service.getItem({
				id: "audit-123",
				app: App.App1,
				resourceType: ResourceType.UNKNOWN,
			});

			expect(result).toEqual(mockAudit);
			expect(mockStorage.getItem).toHaveBeenCalledWith({
				id: "audit-123",
				app: App.App1,
				resourceType: ResourceType.UNKNOWN,
			});
		});

		it("should throw an error when audit is not found", async () => {
			mockStorage.getItem.mockResolvedValue(null);

			await expect(
				service.getItem({
					id: "missing-audit",
					app: App.App1,
					resourceType: ResourceType.UNKNOWN,
				}),
			).rejects.toThrow("Unable to find Audit");
		});

		it("should include identifiers in error message", async () => {
			mockStorage.getItem.mockResolvedValue(null);

			await expect(
				service.getItem({
					id: "test-id",
					app: App.App1,
					resourceType: ResourceType.UNKNOWN,
				}),
			).rejects.toThrow(/id:test-id/);
		});

		it("should throw when storage returns undefined", async () => {
			mockStorage.getItem.mockResolvedValue(undefined);

			await expect(
				service.getItem({
					id: "audit-123",
					app: App.App1,
					resourceType: ResourceType.UNKNOWN,
				}),
			).rejects.toThrow("Unable to find Audit");
		});
	});

	describe("upsertItem", () => {
		const baseInput: UpsertAuditInput = {
			operation: "createUser",
			target: {
				app: App.App1,
				type: ResourceType.UNKNOWN,
				id: "user-123",
			},
			status: "success",
		};

		it("should upsert a single item without resources", async () => {
			await service.upsertItem(baseInput);

			expect(mockStorage.upsertBatch).toHaveBeenCalledWith([
				expect.objectContaining({
					operation: "createUser",
					target: baseInput.target,
				}),
			]);
			expect(mockEvents.upserted).toHaveBeenCalledWith([
				expect.objectContaining({
					operation: "createUser",
				}),
			]);
		});

		it("should create batch entries for resources with IDs", async () => {
			const inputWithResources: UpsertAuditInput = {
				...baseInput,
				id: "parent-id",
				resources: [
					{ app: App.App1, type: ResourceType.UNKNOWN, id: "resource-1" },
					{ app: App.App1, type: ResourceType.UNKNOWN, id: "resource-2" },
				],
			};

			await service.upsertItem(inputWithResources);

			expect(mockStorage.upsertBatch).toHaveBeenCalledWith([
				expect.objectContaining({ operation: "createUser" }),
				expect.objectContaining({
					id: "parent-id#App1.Unknown#resource-1",
					app: App.App1,
					type: ResourceType.UNKNOWN,
					source: baseInput.target,
				}),
				expect.objectContaining({
					id: "parent-id#App1.Unknown#resource-2",
					app: App.App1,
					type: ResourceType.UNKNOWN,
					source: baseInput.target,
				}),
			]);
		});

		it("should filter out resources without IDs", async () => {
			const inputWithMixedResources: UpsertAuditInput = {
				...baseInput,
				id: "parent-id",
				resources: [
					{ app: App.App1, type: ResourceType.UNKNOWN, id: "has-id" },
					{ app: App.App1, type: ResourceType.UNKNOWN }, // No id
				],
			};

			await service.upsertItem(inputWithMixedResources);

			// Should only have 2 items: parent + 1 resource with ID
			expect(mockStorage.upsertBatch).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ operation: "createUser" }),
					expect.objectContaining({ id: "parent-id#App1.Unknown#has-id" }),
				]),
			);
			const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
			expect(batchArg).toHaveLength(2);
		});

		it("should set rerunable from parent when specified", async () => {
			const inputWithRerunable: UpsertAuditInput = {
				...baseInput,
				id: "parent-id",
				rerunable: true,
				resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
			};

			await service.upsertItem(inputWithRerunable);

			const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
			expect(batchArg[1].rerunable).toBe(true);
		});

		it("should set rerunable based on event presence when not specified", async () => {
			const inputWithEvent: UpsertAuditInput = {
				...baseInput,
				id: "parent-id",
				event: { detail: "test", "detail-type": "Test", source: "test" },
				resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
			};

			await service.upsertItem(inputWithEvent);

			const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
			expect(batchArg[1].rerunable).toBe(true);
		});

		it("should set rerunable to false when no event and not specified", async () => {
			const inputWithoutEvent: UpsertAuditInput = {
				...baseInput,
				id: "parent-id",
				resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
			};

			await service.upsertItem(inputWithoutEvent);

			const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
			expect(batchArg[1].rerunable).toBe(false);
		});

		it("should clear event, result, error from child resources", async () => {
			const inputWithExtras: UpsertAuditInput = {
				...baseInput,
				id: "parent-id",
				event: { detail: "test", "detail-type": "Test", source: "test" },
				error: new Error("test error"),
				resources: [{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" }],
			};

			await service.upsertItem(inputWithExtras);

			const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
			expect(batchArg[1].event).toBeUndefined();
			expect(batchArg[1].error).toBeUndefined();
		});

		it("should not call events.upserted when events is null", async () => {
			const serviceWithoutEvents = new AuditService(
				mockLogger as unknown as ConstructorParameters<
					typeof AuditService<typeof testConfig>
				>[0],
				testConfig,
				mockStorage as unknown as ConstructorParameters<
					typeof AuditService<typeof testConfig>
				>[2],
				null,
			);

			await serviceWithoutEvents.upsertItem(baseInput);

			expect(mockStorage.upsertBatch).toHaveBeenCalled();
			// No error should be thrown
		});

		it("should handle empty resources array", async () => {
			const inputWithEmptyResources: UpsertAuditInput = {
				...baseInput,
				resources: [],
			};

			await service.upsertItem(inputWithEmptyResources);

			expect(mockStorage.upsertBatch).toHaveBeenCalledWith([
				expect.objectContaining({ operation: "createUser" }),
			]);
		});

		describe("attempt tracking", () => {
			it("should create attempts array with first attempt on new audit", async () => {
				mockStorage.getItem.mockResolvedValue(null);

				await service.upsertItem({
					...baseInput,
					id: "new-audit-id",
				});

				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				expect(batchArg[0].attempts).toHaveLength(1);
				expect(batchArg[0].attempts[0]).toMatchObject({
					number: 1,
					status: "success",
				});
				expect(batchArg[0].attempts[0].at).toBeDefined();
			});

			it("should append to attempts array on retry", async () => {
				const existingAudit = {
					id: "existing-audit-id",
					operation: "createUser",
					status: "fail",
					target: baseInput.target,
					createdAt: new Date("2024-01-01T00:00:00Z"),
					attempts: [
						{
							number: 1,
							status: "fail",
							error: "Connection timeout",
							at: "2024-01-01T00:00:00Z",
						},
					],
				};
				mockStorage.getItem.mockResolvedValue(existingAudit);

				await service.upsertItem({
					...baseInput,
					id: "existing-audit-id",
					status: "success",
				});

				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				expect(batchArg[0].attempts).toHaveLength(2);
				expect(batchArg[0].attempts[0]).toMatchObject({
					number: 1,
					status: "fail",
					error: "Connection timeout",
				});
				expect(batchArg[0].attempts[1]).toMatchObject({
					number: 2,
					status: "success",
				});
			});

			it("should preserve createdAt from original audit on retry", async () => {
				const originalCreatedAt = new Date("2024-01-01T00:00:00Z");
				const existingAudit = {
					id: "existing-audit-id",
					operation: "createUser",
					status: "fail",
					target: baseInput.target,
					createdAt: originalCreatedAt,
					attempts: [{ number: 1, status: "fail", at: "2024-01-01T00:00:00Z" }],
				};
				mockStorage.getItem.mockResolvedValue(existingAudit);

				await service.upsertItem({
					...baseInput,
					id: "existing-audit-id",
					status: "success",
				});

				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				expect(batchArg[0].createdAt).toEqual(originalCreatedAt.toISOString());
			});

			it("should capture error in attempt record when status is fail", async () => {
				mockStorage.getItem.mockResolvedValue(null);

				await service.upsertItem({
					...baseInput,
					id: "new-audit-id",
					status: "fail",
					error: "Connection refused",
				});

				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				expect(batchArg[0].attempts[0]).toMatchObject({
					number: 1,
					status: "fail",
					error: "Connection refused",
				});
			});

			it("should handle existing audit without attempts array", async () => {
				const existingAuditWithoutAttempts = {
					id: "old-audit-id",
					operation: "createUser",
					status: "fail",
					target: baseInput.target,
					createdAt: new Date("2024-01-01T00:00:00Z"),
					// No attempts array - legacy audit
				};
				mockStorage.getItem.mockResolvedValue(existingAuditWithoutAttempts);

				await service.upsertItem({
					...baseInput,
					id: "old-audit-id",
					status: "success",
				});

				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				expect(batchArg[0].attempts).toHaveLength(1);
				expect(batchArg[0].attempts[0].number).toBe(1);
			});

			it("should not copy attempts to related resources", async () => {
				mockStorage.getItem.mockResolvedValue(null);

				await service.upsertItem({
					...baseInput,
					id: "parent-id",
					resources: [
						{ app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" },
					],
				});

				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				// Parent should have attempts
				expect(batchArg[0].attempts).toHaveLength(1);
				// Child resource should not have attempts
				expect(batchArg[1].attempts).toBeUndefined();
			});

			it("should create attempts array when no id provided", async () => {
				await service.upsertItem({
					...baseInput,
					// No id - will be auto-generated
				});

				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				expect(batchArg[0].attempts).toHaveLength(1);
				expect(batchArg[0].attempts[0].number).toBe(1);
			});

			it("should handle storage.getItem throwing an error", async () => {
				mockStorage.getItem.mockRejectedValue(new Error("DynamoDB error"));

				await service.upsertItem({
					...baseInput,
					id: "some-id",
				});

				// Should still create the audit with first attempt
				const batchArg = mockStorage.upsertBatch.mock.calls[0][0];
				expect(batchArg[0].attempts).toHaveLength(1);
				expect(batchArg[0].attempts[0].number).toBe(1);
			});
		});
	});

	describe("listItems", () => {
		const mockResponse = {
			items: [{ id: "audit-1" }, { id: "audit-2" }],
			pagination: { nextToken: "token123" },
		};

		it("should return list items from storage", async () => {
			mockStorage.listItems.mockResolvedValue(mockResponse);

			const result = await service.listItems({
				app: App.App1,
				resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
			});

			expect(result).toEqual(mockResponse);
			expect(mockStorage.listItems).toHaveBeenCalled();
		});

		it("should pass pagination parameters", async () => {
			mockStorage.listItems.mockResolvedValue(mockResponse);

			await service.listItems(
				{
					app: App.App1,
					resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
				},
				{ pageSize: 10, nextToken: "abc" },
			);

			expect(mockStorage.listItems).toHaveBeenCalledWith(
				{
					app: App.App1,
					resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
				},
				{ pageSize: 10, nextToken: "abc" },
			);
		});

		it("should rethrow async errors from storage", async () => {
			const error = new Error("Storage error");
			mockStorage.listItems.mockRejectedValue(error);

			await expect(
				service.listItems({
					app: App.App1,
					resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
				}),
			).rejects.toThrow("Storage error");

			// Note: The try-catch in the code doesn't actually catch async errors
			// because the promise is returned directly without await.
			// This is a known limitation - errors propagate but aren't logged.
		});

		it("should log and rethrow synchronous errors", async () => {
			const error = new Error("Sync storage error");
			mockStorage.listItems.mockImplementation(() => {
				throw error;
			});

			await expect(
				service.listItems({
					app: App.App1,
					resource: { type: ResourceType.UNKNOWN, id: "resource-123" },
				}),
			).rejects.toThrow("Sync storage error");

			expect(mockLogger.error).toHaveBeenCalledWith(
				"An error occurred while trying to list items",
				{ error },
			);
		});
	});

	describe("listTraceItems", () => {
		const mockResponse = {
			items: [{ id: "trace-audit-1" }, { id: "trace-audit-2" }],
			pagination: {},
		};

		it("should return trace items from storage", async () => {
			mockStorage.listTraceItems.mockResolvedValue(mockResponse);

			const result = await service.listTraceItems({
				trace: "trace-abc-123",
			});

			expect(result).toEqual(mockResponse);
			expect(mockStorage.listTraceItems).toHaveBeenCalledWith(
				{ trace: "trace-abc-123" },
				undefined,
			);
		});

		it("should pass pagination parameters", async () => {
			mockStorage.listTraceItems.mockResolvedValue(mockResponse);

			await service.listTraceItems(
				{ trace: "trace-abc-123" },
				{ pageSize: 5, nextToken: "xyz" },
			);

			expect(mockStorage.listTraceItems).toHaveBeenCalledWith(
				{ trace: "trace-abc-123" },
				{ pageSize: 5, nextToken: "xyz" },
			);
		});

		it("should rethrow errors from storage", async () => {
			const error = new Error("Trace query failed");
			mockStorage.listTraceItems.mockRejectedValue(error);

			await expect(
				service.listTraceItems({ trace: "trace-abc-123" }),
			).rejects.toThrow("Trace query failed");

			// Note: The try-catch in the code doesn't actually catch async errors
			// because the promise is returned directly without await.
			// This is a known limitation - errors propagate but aren't logged.
		});

		it("should log and rethrow synchronous errors", async () => {
			const error = new Error("Sync trace query error");
			mockStorage.listTraceItems.mockImplementation(() => {
				throw error;
			});

			await expect(
				service.listTraceItems({ trace: "trace-abc-123" }),
			).rejects.toThrow("Sync trace query error");

			expect(mockLogger.error).toHaveBeenCalledWith(
				"An error occurred while trying to list trace items",
				{ error },
			);
		});
	});
});
