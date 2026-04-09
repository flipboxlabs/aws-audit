import type { MiddyLikeRequest } from "@aws-lambda-powertools/commons/types";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Audits } from "../audits.js";
import type { AuditConfig } from "../config.js";
import { logAudits } from "./middy.js";

describe("logAudits middleware", () => {
  let mockAudits: {
    logger: {
      info: ReturnType<typeof vi.fn>;
    };
    publishStoredAudits: ReturnType<typeof vi.fn>;
  };

  let mockRequest: MiddyLikeRequest;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAudits = {
      logger: {
        info: vi.fn(),
      },
      publishStoredAudits: vi.fn(),
    };

    mockRequest = {
      event: { testKey: "testValue" },
      context: {} as MiddyLikeRequest["context"],
      response: null,
      error: null,
      internal: {},
    };
  });

  describe("middleware structure", () => {
    it("should return an object with before, after, and onError hooks", () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);

      expect(middleware).toHaveProperty("before");
      expect(middleware).toHaveProperty("after");
      expect(middleware).toHaveProperty("onError");
      expect(typeof middleware.before).toBe("function");
      expect(typeof middleware.after).toBe("function");
      expect(typeof middleware.onError).toBe("function");
    });
  });

  describe("before hook", () => {
    it("should set cleanup function on request.internal", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);

      await middleware.before!(mockRequest);

      const cleanupKey = `audits`;
      expect(mockRequest.internal).toHaveProperty(cleanupKey);
      expect(typeof mockRequest.internal[cleanupKey]).toBe("function");
    });

    it("should preserve existing internal properties", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      mockRequest.internal = { existingKey: "existingValue" };

      await middleware.before!(mockRequest);

      expect(mockRequest.internal).toHaveProperty("existingKey", "existingValue");
      const cleanupKey = `audits`;
      expect(mockRequest.internal).toHaveProperty(cleanupKey);
    });

    it("should handle undefined internal object", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      mockRequest.internal = undefined as unknown as Record<string, unknown>;

      await middleware.before!(mockRequest);

      const cleanupKey = `audits`;
      expect(mockRequest.internal).toHaveProperty(cleanupKey);
    });
  });

  describe("after hook", () => {
    it("should log the request event", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);

      await middleware.after!(mockRequest);

      expect(mockAudits.logger.info).toHaveBeenCalledTimes(1);
      expect(mockAudits.logger.info).toHaveBeenCalledWith(mockRequest.event);
    });

    it("should call publishStoredAudits", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);

      await middleware.after!(mockRequest);

      expect(mockAudits.publishStoredAudits).toHaveBeenCalledTimes(1);
    });

    it("should handle complex event objects", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      mockRequest.event = {
        Records: [
          { eventSource: "aws:sqs", body: '{"key": "value"}' },
          { eventSource: "aws:sqs", body: '{"key": "value2"}' },
        ],
      };

      await middleware.after!(mockRequest);

      expect(mockAudits.logger.info).toHaveBeenCalledWith(mockRequest.event);
    });
  });

  describe("onError hook", () => {
    it("should log the request event on error", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      mockRequest.error = new Error("Test error");

      await middleware.onError!(mockRequest);

      expect(mockAudits.logger.info).toHaveBeenCalledTimes(1);
      expect(mockAudits.logger.info).toHaveBeenCalledWith(mockRequest.event);
    });

    it("should call publishStoredAudits on error", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      mockRequest.error = new Error("Test error");

      await middleware.onError!(mockRequest);

      expect(mockAudits.publishStoredAudits).toHaveBeenCalledTimes(1);
    });

    it("should use same function as after hook", () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);

      expect(middleware.after).toBe(middleware.onError);
    });
  });

  describe("cleanup function", () => {
    it("should be callable from request.internal", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      await middleware.before!(mockRequest);

      const cleanupKey = `audits`;
      const cleanup = mockRequest.internal[cleanupKey] as (
        request: MiddyLikeRequest,
      ) => Promise<void>;

      await cleanup(mockRequest);

      expect(mockAudits.logger.info).toHaveBeenCalledTimes(1);
      expect(mockAudits.publishStoredAudits).toHaveBeenCalledTimes(1);
    });

    it("should allow early middleware return cleanup", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      await middleware.before!(mockRequest);

      // Simulate another middleware calling the cleanup function directly
      const cleanupKey = `audits`;
      const cleanup = mockRequest.internal[cleanupKey] as (
        request: MiddyLikeRequest,
      ) => Promise<void>;

      // First call via cleanup
      await cleanup(mockRequest);
      expect(mockAudits.publishStoredAudits).toHaveBeenCalledTimes(1);

      // Second call via after (simulating normal flow)
      await middleware.after!(mockRequest);
      expect(mockAudits.publishStoredAudits).toHaveBeenCalledTimes(2);
    });
  });

  describe("integration scenarios", () => {
    it("should handle full request lifecycle", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);

      // Before hook
      await middleware.before!(mockRequest);

      const cleanupKey = `audits`;
      expect(mockRequest.internal).toHaveProperty(cleanupKey);

      // After hook
      await middleware.after!(mockRequest);

      expect(mockAudits.logger.info).toHaveBeenCalledWith(mockRequest.event);
      expect(mockAudits.publishStoredAudits).toHaveBeenCalled();
    });

    it("should handle request lifecycle with error", async () => {
      const middleware = logAudits(mockAudits as unknown as Audits<AuditConfig>);

      // Before hook
      await middleware.before!(mockRequest);

      // Simulate error
      mockRequest.error = new Error("Handler failed");

      // OnError hook
      await middleware.onError!(mockRequest);

      expect(mockAudits.logger.info).toHaveBeenCalledWith(mockRequest.event);
      expect(mockAudits.publishStoredAudits).toHaveBeenCalled();
    });

    it("should work with multiple middleware instances", async () => {
      const mockAudits2 = {
        logger: { info: vi.fn() },
        publishStoredAudits: vi.fn(),
      };

      const middleware1 = logAudits(mockAudits as unknown as Audits<AuditConfig>);
      const middleware2 = logAudits(mockAudits2 as unknown as Audits<AuditConfig>);

      await middleware1.before!(mockRequest);
      await middleware1.after!(mockRequest);

      await middleware2.before!(mockRequest);
      await middleware2.after!(mockRequest);

      expect(mockAudits.publishStoredAudits).toHaveBeenCalledTimes(1);
      expect(mockAudits2.publishStoredAudits).toHaveBeenCalledTimes(1);
    });
  });
});
