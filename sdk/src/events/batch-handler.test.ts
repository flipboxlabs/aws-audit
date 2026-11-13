import type { PutEventsCommandOutput } from "@aws-sdk/client-eventbridge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BatchHandler, PutEventsError } from "./batch-handler.js";

describe("BatchHandler", () => {
  let mockLogger: {
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
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
      warn: vi.fn(),
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

    it.each([0, 11, Number.NaN])(
      "should log critical and return empty array for chunk %s",
      async (chunk) => {
        const entries = [{ DetailType: "Test", Detail: "{}", Source: "test" }];

        const result = await handler.putEvents(entries, chunk);

        expect(result).toEqual([]);
        expect(mockClient.send).not.toHaveBeenCalled();
        expect(mockLogger.critical).toHaveBeenCalledWith(
          "Error pushing event bridge events",
          expect.any(RangeError),
        );
      },
    );

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

    it("should return rejected entries without throwing", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      const entries = [{ DetailType: "Test", Detail: "{}", Source: "test" }];

      const result = await handler.putEvents(entries);

      expect(result).toEqual([{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }]);
    });
  });

  describe("putEventsOrThrow", () => {
    const entries = [
      { DetailType: "Test", Detail: "{}", Source: "test" },
      { DetailType: "Test", Detail: "{}", Source: "test" },
    ];

    it("should return results when every entry is accepted", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-1" }, { EventId: "event-2" }],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      const result = await handler.putEventsOrThrow(entries);

      expect(result).toEqual([{ EventId: "event-1" }, { EventId: "event-2" }]);
      expect(mockLogger.debug).toHaveBeenCalledWith("Pushed event bridge events", {
        events: result,
      });
    });

    it("should chunk events into batches of specified size", async () => {
      mockClient.send.mockResolvedValue({ $metadata: {}, Entries: [{ EventId: "event" }] });

      await handler.putEventsOrThrow(entries, 1);

      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it.each([0, 11, Number.NaN])("should throw RangeError for chunk %s", async (chunk) => {
      await expect(handler.putEventsOrThrow(entries, chunk)).rejects.toThrow(RangeError);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it("should handle empty entries array", async () => {
      const result = await handler.putEventsOrThrow([]);

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("should throw PutEventsError with the client error as cause", async () => {
      const error = new Error("EventBridge error");
      mockClient.send.mockRejectedValue(error);

      const thrown = await handler.putEventsOrThrow(entries).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(PutEventsError);
      expect(thrown).toMatchObject({ cause: error, failedEntries: [], results: [] });
      expect(mockLogger.critical).not.toHaveBeenCalled();
    });

    it("should throw PutEventsError with the rejected entries", async () => {
      const mockOutput: PutEventsCommandOutput = {
        $metadata: {},
        FailedEntryCount: 1,
        Entries: [
          { EventId: "event-1" },
          { ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" },
        ],
      };
      mockClient.send.mockResolvedValue(mockOutput);

      const thrown = await handler.putEventsOrThrow(entries).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(PutEventsError);
      expect(thrown).toMatchObject({
        message: "EventBridge accepted 1 of 2 events",
        failedEntries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }],
        results: [
          { EventId: "event-1" },
          { ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" },
        ],
      });
    });

    it("should throw PutEventsError when a later chunk has rejected entries", async () => {
      mockClient.send
        .mockResolvedValueOnce({ $metadata: {}, Entries: [{ EventId: "event-1" }] })
        .mockResolvedValueOnce({
          $metadata: {},
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: "InternalFailure" }],
        });

      await expect(handler.putEventsOrThrow(entries, 1)).rejects.toMatchObject({
        failedEntries: [{ ErrorCode: "InternalFailure" }],
      });
    });

    it("should throw PutEventsError when the response has no result entries", async () => {
      mockClient.send.mockResolvedValue({ $metadata: {} });

      await expect(handler.putEventsOrThrow(entries)).rejects.toMatchObject({
        name: "PutEventsError",
        message: "EventBridge accepted 0 of 2 events",
        failedEntries: [],
      });
    });
  });

  describe("putEventsWithRetry", () => {
    const entries = [
      { DetailType: "Test-0", Detail: "{}", Source: "test" },
      { DetailType: "Test-1", Detail: "{}", Source: "test" },
    ];

    /** Request entries sent by the nth PutEvents call */
    const sentEntries = (call: number) => mockClient.send.mock.calls[call][0].input.Entries;

    /** A PutEvents response rejecting every entry sent with `ErrorCode` */
    const rejectAll =
      (ErrorCode: string) => async (command: { input: { Entries: unknown[] } }) => ({
        $metadata: {},
        FailedEntryCount: command.input.Entries.length,
        Entries: command.input.Entries.map(() => ({ ErrorCode })),
      });

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** Starts the call and runs the backoff timers until it settles */
    const run = async (...args: Parameters<BatchHandler["putEventsWithRetry"]>) => {
      const promise = handler.putEventsWithRetry(...args).catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      return promise;
    };

    it("should make one call when every entry is accepted the first time", async () => {
      mockClient.send.mockResolvedValue({
        $metadata: {},
        FailedEntryCount: 0,
        Entries: [{ EventId: "event-1" }, { EventId: "event-2" }],
      });

      const result = await run(entries);

      expect(result).toEqual([{ EventId: "event-1" }, { EventId: "event-2" }]);
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith("Pushed event bridge events", {
        events: result,
      });
    });

    it("should handle empty entries array", async () => {
      const result = await run([]);

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("should retry only the throttled entries and return results in request order", async () => {
      mockClient.send
        .mockResolvedValueOnce({
          $metadata: {},
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: "ThrottlingException" }, { EventId: "event-2" }],
        })
        .mockResolvedValueOnce({
          $metadata: {},
          FailedEntryCount: 0,
          Entries: [{ EventId: "event-1" }],
        });

      const result = await run(entries);

      expect(result).toEqual([{ EventId: "event-1" }, { EventId: "event-2" }]);
      expect(mockClient.send).toHaveBeenCalledTimes(2);
      expect(sentEntries(1)).toEqual([entries[0]]);
      expect(mockLogger.warn).toHaveBeenCalledWith("Retrying event bridge events", {
        count: 1,
        attempt: 1,
        delayMs: expect.any(Number),
      });
    });

    it.each(["InternalException", "InternalFailure", "ServiceUnavailable", "ThrottlingException"])(
      "should retry an entry rejected with %s",
      async (ErrorCode) => {
        mockClient.send.mockImplementationOnce(rejectAll(ErrorCode)).mockResolvedValueOnce({
          $metadata: {},
          Entries: [{ EventId: "event-1" }, { EventId: "event-2" }],
        });

        const result = await run(entries);

        expect(result).toEqual([{ EventId: "event-1" }, { EventId: "event-2" }]);
        expect(mockClient.send).toHaveBeenCalledTimes(2);
      },
    );

    it.each(["MalformedDetail", "InvalidArgument", "AccessDeniedException"])(
      "should fail an entry rejected with %s without a retry",
      async (ErrorCode) => {
        mockClient.send.mockResolvedValue({
          $metadata: {},
          FailedEntryCount: 1,
          Entries: [{ EventId: "event-1" }, { ErrorCode }],
        });

        const thrown = await run(entries);

        expect(thrown).toBeInstanceOf(PutEventsError);
        expect(thrown).toMatchObject({
          message: "EventBridge accepted 1 of 2 events after 1 attempt",
          failedEntries: [{ ErrorCode }],
          results: [{ EventId: "event-1" }, { ErrorCode }],
        });
        expect(mockClient.send).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).not.toHaveBeenCalled();
      },
    );

    it("should fail entries without a result entry without resending them", async () => {
      mockClient.send.mockResolvedValue({ $metadata: {}, Entries: [{ EventId: "event-1" }] });

      const thrown = await run(entries);

      expect(thrown).toMatchObject({
        message: "EventBridge accepted 1 of 2 events after 1 attempt",
        failedEntries: [],
        results: [{ EventId: "event-1" }],
      });
      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it("should not resend a thrown call", async () => {
      const error = new Error("EventBridge error");
      mockClient.send.mockRejectedValue(error);

      const thrown = await run(entries);

      expect(thrown).toBeInstanceOf(PutEventsError);
      expect(thrown).toMatchObject({
        message: "EventBridge accepted 0 of 2 events after 1 attempt",
        failedEntries: [],
        results: [],
        cause: error,
      });
      expect(mockClient.send).toHaveBeenCalledTimes(1);
      expect(mockLogger.critical).not.toHaveBeenCalled();
    });

    it("should keep sending the other chunks after one throws", async () => {
      const error = new Error("EventBridge error");
      mockClient.send
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ $metadata: {}, Entries: [{ EventId: "event-2" }] });

      const thrown = await run(entries, { chunk: 1 });

      expect(thrown).toMatchObject({
        message: "EventBridge accepted 1 of 2 events after 1 attempt",
        results: [{ EventId: "event-2" }],
        cause: error,
      });
      expect(mockClient.send).toHaveBeenCalledTimes(2);
      expect(sentEntries(1)).toEqual([entries[1]]);
    });

    it("should not resend a retry that throws", async () => {
      const error = new Error("EventBridge error");
      mockClient.send
        .mockResolvedValueOnce({
          $metadata: {},
          FailedEntryCount: 1,
          Entries: [{ EventId: "event-1" }, { ErrorCode: "ThrottlingException" }],
        })
        .mockRejectedValueOnce(error);

      const thrown = await run(entries);

      expect(thrown).toMatchObject({
        message: "EventBridge accepted 1 of 2 events after 2 attempts",
        failedEntries: [{ ErrorCode: "ThrottlingException" }],
        cause: error,
      });
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it("should throw PutEventsError after 3 attempts when an entry is always throttled", async () => {
      mockClient.send
        .mockResolvedValueOnce({
          $metadata: {},
          FailedEntryCount: 1,
          Entries: [{ EventId: "event-1" }, { ErrorCode: "ThrottlingException" }],
        })
        .mockResolvedValue({
          $metadata: {},
          FailedEntryCount: 1,
          Entries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }],
        });

      const thrown = await run(entries);

      expect(thrown).toBeInstanceOf(PutEventsError);
      expect(thrown).toMatchObject({
        message: "EventBridge accepted 1 of 2 events after 3 attempts",
        failedEntries: [{ ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" }],
        results: [
          { EventId: "event-1" },
          { ErrorCode: "ThrottlingException", ErrorMessage: "Rate exceeded" },
        ],
      });
      expect(thrown).not.toHaveProperty("cause");
      expect(mockClient.send).toHaveBeenCalledTimes(3);
      expect(sentEntries(1)).toEqual([entries[1]]);
      expect(sentEntries(2)).toEqual([entries[1]]);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    it("should make as many attempts as configured", async () => {
      mockClient.send.mockImplementation(rejectAll("ThrottlingException"));

      const thrown = await run(entries, { attempts: 1 });

      expect(thrown).toBeInstanceOf(PutEventsError);
      expect(mockClient.send).toHaveBeenCalledTimes(1);
    });

    it("should double the jittered delay on each retry", async () => {
      mockClient.send.mockImplementation(rejectAll("ThrottlingException"));

      vi.spyOn(Math, "random").mockReturnValue(1);
      await run(entries, { attempts: 3, baseDelay: 200 });

      expect(mockLogger.warn.mock.calls.map(([, { delayMs }]) => delayMs)).toEqual([200, 400]);

      vi.spyOn(Math, "random").mockReturnValue(0);
      mockLogger.warn.mockClear();
      await run(entries, { attempts: 3, baseDelay: 200 });

      expect(mockLogger.warn.mock.calls.map(([, { delayMs }]) => delayMs)).toEqual([100, 200]);
    });

    it("should cap the delay at 30 seconds", async () => {
      mockClient.send.mockImplementation(rejectAll("ThrottlingException"));
      vi.spyOn(Math, "random").mockReturnValue(1);

      await run(entries, { attempts: 4, baseDelay: 20_000 });

      expect(mockLogger.warn.mock.calls.map(([, { delayMs }]) => delayMs)).toEqual([
        20_000, 30_000, 30_000,
      ]);
    });

    it("should wait out the delay before retrying", async () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      mockClient.send
        .mockImplementationOnce(rejectAll("ThrottlingException"))
        .mockResolvedValueOnce({
          $metadata: {},
          Entries: [{ EventId: "event-1" }, { EventId: "event-2" }],
        });

      const promise = handler.putEventsWithRetry(entries);
      await vi.advanceTimersByTimeAsync(99);
      expect(mockClient.send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(mockClient.send).toHaveBeenCalledTimes(2);
    });

    it.each([0, 1.5, Number.NaN])("should throw RangeError for attempts %s", async (attempts) => {
      await expect(handler.putEventsWithRetry(entries, { attempts })).rejects.toThrow(RangeError);
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      "should throw RangeError for baseDelay %s",
      async (baseDelay) => {
        await expect(handler.putEventsWithRetry(entries, { baseDelay })).rejects.toThrow(
          RangeError,
        );
        expect(mockClient.send).not.toHaveBeenCalled();
      },
    );

    it.each([0, 11])("should throw RangeError for chunk %s", async (chunk) => {
      await expect(handler.putEventsWithRetry(entries, { chunk })).rejects.toThrow(RangeError);
      expect(mockClient.send).not.toHaveBeenCalled();
    });
  });
});
