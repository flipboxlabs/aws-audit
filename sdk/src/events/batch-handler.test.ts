import type { PutEventsCommandOutput } from "@aws-sdk/client-eventbridge";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BatchHandler } from "./batch-handler.js";

describe("BatchHandler", () => {
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    critical: ReturnType<typeof vi.fn>;
  };
  let mockClient: {
    send: ReturnType<typeof vi.fn>;
  };
  let handler: BatchHandler;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      debug: vi.fn(),
      critical: vi.fn(),
    };

    mockClient = {
      send: vi.fn(),
    };

    handler = new BatchHandler(
      mockLogger as unknown as ConstructorParameters<typeof BatchHandler>[0],
      mockClient as unknown as ConstructorParameters<typeof BatchHandler>[1],
    );
  });

  describe("constructor", () => {
    it("should create an instance with provided dependencies", () => {
      expect(handler).toBeInstanceOf(BatchHandler);
    });
  });

  describe("putEvents", () => {
    it("should send events and return results on success", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        Entries: [{ EventId: "event-1" }, { EventId: "event-2" }],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      const entries = [
        { DetailType: "Test", Detail: "{}", Source: "test" },
        { DetailType: "Test", Detail: "{}", Source: "test" },
      ];

      const result = await handler.putEvents(entries);

      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith("Pushed event bridge events", {
        events: expect.any(Array),
      });
      expect(result).toEqual([{ EventId: "event-1" }, { EventId: "event-2" }]);
    });

    it("should chunk events into batches of specified size", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        Entries: [{ EventId: "event-1" }],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      // Create 5 entries and use chunk size of 2
      const entries = Array.from({ length: 5 }, (_, i) => ({
        DetailType: `Test-${i}`,
        Detail: "{}",
        Source: "test",
      }));

      await handler.putEvents(entries, 2);

      // Should be called 3 times: 2 + 2 + 1
      expect(mockClient.send).toHaveBeenCalledTimes(3);
    });

    it("should use default chunk size of 10", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        Entries: [],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      // Create 15 entries
      const entries = Array.from({ length: 15 }, (_, i) => ({
        DetailType: `Test-${i}`,
        Detail: "{}",
        Source: "test",
      }));

      await handler.putEvents(entries);

      // Should be called 2 times: 10 + 5
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it("should handle empty entries array", async () => {
      const result = await handler.putEvents([]);

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("should log critical and return empty array on error", async () => {
      const error = new Error("EventBridge error");
      mockClient.send.mockRejectedValue(error);

      const entries = [{ DetailType: "Test", Detail: "{}", Source: "test" }];

      const result = await handler.putEvents(entries);

      expect(mockLogger.critical).toHaveBeenCalledWith("Error pushing event bridge events", error);
      expect(result).toEqual([]);
    });

    it("should handle response without Entries", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        // No Entries property
      };
      mockClient.send.mockResolvedValue(mockOutput);

      const entries = [{ DetailType: "Test", Detail: "{}", Source: "test" }];

      const result = await handler.putEvents(entries);

      expect(result).toEqual([]);
    });

    it("should process single entry", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        Entries: [{ EventId: "single-event" }],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      const entries = [{ DetailType: "Test", Detail: "{}", Source: "test" }];

      await handler.putEvents(entries);

      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it("should handle exactly chunk size entries", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        Entries: [],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      // Create exactly 10 entries (default chunk size)
      const entries = Array.from({ length: 10 }, (_, i) => ({
        DetailType: `Test-${i}`,
        Detail: "{}",
        Source: "test",
      }));

      await handler.putEvents(entries);

      // Should be called exactly once
      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });
  });
});
