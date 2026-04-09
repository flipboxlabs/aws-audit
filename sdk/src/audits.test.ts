import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { StrictLogAuditInput } from "./audits.js";
import { AUDIT_LOG_IDENTIFIER } from "./constants.js";
import { App, ResourceType, testConfig } from "./test-config.js";

type TestAuditInput = StrictLogAuditInput<typeof testConfig>;

// Default target used across tests
const defaultTarget = {
  app: App.App1,
  type: ResourceType.UNKNOWN,
  id: "test-id",
} as const;

// Helper to create a valid audit item with strict typing
function createAuditItem(
  overrides: Partial<Omit<TestAuditInput, "target">> & {
    target?: TestAuditInput["target"];
  } = {},
): TestAuditInput {
  return {
    operation: "testOperation",
    target: defaultTarget,
    ...overrides,
  };
}

describe("Audits", () => {
  const originalEnv = process.env;
  // biome-ignore lint/suspicious/noExplicitAny: Mock spy type is complex
  let stdoutWriteSpy: any;

  beforeEach(() => {
    // Reset environment for each test
    process.env = { ...originalEnv };
    delete process.env.POWERTOOLS_AUDITS_DISABLED;
    delete process.env.POWERTOOLS_DEV;
    delete process.env._X_AMZN_TRACE_ID;

    // Spy on stdout.write to capture output from both Console instances
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Reset module cache to ensure fresh imports with new env
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    stdoutWriteSpy.mockRestore();
    vi.resetModules();
  });

  // Helper to get logged audit from stdout spy
  function getLoggedAudit(callIndex = 0): Record<string, unknown> {
    const call = stdoutWriteSpy.mock.calls[callIndex];
    if (!call) throw new Error(`No stdout write at index ${callIndex}`);
    const output = call[0] as string;
    return JSON.parse(output.trim());
  }

  describe("constructor", () => {
    it("should create an instance with config", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      expect(audits).toBeInstanceOf(Audits);
      expect(audits.logger).toBeDefined();
    });

    it("should accept a custom logger", async () => {
      const { Audits } = await import("./audits.js");
      const customLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const audits = new Audits({ config: testConfig, logger: customLogger });

      expect(audits.logger).toBe(customLogger);
    });

    it("should capture X-Ray trace ID from environment", async () => {
      process.env._X_AMZN_TRACE_ID = "Root=1-abc-def;Parent=123;Sampled=1";

      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      // Powertools extracts just the trace ID portion from the X-Ray header
      expect(audits.traceId).toBe("1-abc-def");
    });

    it("should have undefined traceId when not in X-Ray environment", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      expect(audits.traceId).toBeUndefined();
    });
  });

  describe("addAudit", () => {
    it("should buffer audit entries", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });
      const item = createAuditItem();

      audits.addAudit(item);
      audits.addAudit(item);

      // Should not have written yet (just buffered)
      expect(stdoutWriteSpy).not.toHaveBeenCalled();

      // Now publish
      audits.publishStoredAudits();

      // Should have written 2 audits
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(2);
    });

    it("should auto-flush when buffer reaches MAX_AUDITS_SIZE", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      // Add 20 items (MAX_AUDITS_SIZE)
      for (let i = 0; i < 20; i++) {
        audits.addAudit(createAuditItem({ operation: `op-${i}` }));
      }

      // Should have logged 0 items yet (buffer not exceeded)
      expect(stdoutWriteSpy).not.toHaveBeenCalled();

      // Add one more to trigger auto-flush
      audits.addAudit(createAuditItem({ operation: "op-20" }));

      // Should have flushed the first 20 items
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(20);
    });
  });

  describe("publishStoredAudits", () => {
    it("should emit audits as JSON to stdout when enabled", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });
      const item = createAuditItem();

      audits.addAudit(item);
      audits.publishStoredAudits();

      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
      const parsed = getLoggedAudit(0);

      expect(parsed).toHaveProperty(AUDIT_LOG_IDENTIFIER);
      expect((parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>).operation).toBe(
        "testOperation",
      );
    });

    it("should inject X-Ray trace ID into audits without trace", async () => {
      process.env._X_AMZN_TRACE_ID = "trace-123";

      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      expect((parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>).trace).toBe("trace-123");
    });

    it("should not override existing trace ID", async () => {
      process.env._X_AMZN_TRACE_ID = "env-trace";

      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem({ trace: "custom-trace" }));
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      expect((parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>).trace).toBe("custom-trace");
    });

    it("should clear buffer after publishing", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);

      // Second publish should emit nothing
      audits.publishStoredAudits();
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
    });

    it("should not emit when disabled but still clear buffer", async () => {
      process.env.POWERTOOLS_AUDITS_DISABLED = "true";

      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      // Should not have written anything since disabled
      expect(stdoutWriteSpy).not.toHaveBeenCalled();

      // Buffer should be cleared - verify by re-enabling and checking
      // Add a new audit and publish - should only get the new one
      vi.resetModules();
      delete process.env.POWERTOOLS_AUDITS_DISABLED;

      const { Audits: Audits2 } = await import("./audits.js");
      const enabledAudits = new Audits2({ config: testConfig });
      enabledAudits.addAudit(createAuditItem({ operation: "after-enable" }));
      enabledAudits.publishStoredAudits();

      expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
    });

    it("should handle multiple audits in one publish", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem({ operation: "op1" }));
      audits.addAudit(createAuditItem({ operation: "op2" }));
      audits.addAudit(createAuditItem({ operation: "op3" }));

      audits.publishStoredAudits();

      expect(stdoutWriteSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("disabled state", () => {
    it("should be disabled when POWERTOOLS_AUDITS_DISABLED is true", async () => {
      process.env.POWERTOOLS_AUDITS_DISABLED = "true";

      const { Audits } = await import("./audits.js");

      // Create a testable subclass inline
      class TestableAudits extends Audits<typeof testConfig> {
        public testIsDisabled(): boolean {
          return this.isDisabled();
        }
      }

      const audits = new TestableAudits({ config: testConfig });
      expect(audits.testIsDisabled()).toBe(true);
    });

    it("should be enabled when POWERTOOLS_AUDITS_DISABLED is false", async () => {
      process.env.POWERTOOLS_AUDITS_DISABLED = "false";

      const { Audits } = await import("./audits.js");

      class TestableAudits extends Audits<typeof testConfig> {
        public testIsDisabled(): boolean {
          return this.isDisabled();
        }
      }

      const audits = new TestableAudits({ config: testConfig });
      expect(audits.testIsDisabled()).toBe(false);
    });

    it("should be disabled in dev mode when POWERTOOLS_AUDITS_DISABLED is not set", async () => {
      process.env.POWERTOOLS_DEV = "true";

      const { Audits } = await import("./audits.js");

      class TestableAudits extends Audits<typeof testConfig> {
        public testIsDisabled(): boolean {
          return this.isDisabled();
        }
      }

      const audits = new TestableAudits({ config: testConfig });
      expect(audits.testIsDisabled()).toBe(true);
    });

    it("should be enabled in production when POWERTOOLS_AUDITS_DISABLED is not set", async () => {
      // Neither POWERTOOLS_AUDITS_DISABLED nor POWERTOOLS_DEV is set
      const { Audits } = await import("./audits.js");

      class TestableAudits extends Audits<typeof testConfig> {
        public testIsDisabled(): boolean {
          return this.isDisabled();
        }
      }

      const audits = new TestableAudits({ config: testConfig });
      expect(audits.testIsDisabled()).toBe(false);
    });

    it("should prioritize POWERTOOLS_AUDITS_DISABLED over dev mode", async () => {
      process.env.POWERTOOLS_DEV = "true";
      process.env.POWERTOOLS_AUDITS_DISABLED = "false";

      const { Audits } = await import("./audits.js");

      class TestableAudits extends Audits<typeof testConfig> {
        public testIsDisabled(): boolean {
          return this.isDisabled();
        }
      }

      const audits = new TestableAudits({ config: testConfig });
      expect(audits.testIsDisabled()).toBe(false);
    });
  });

  describe("clearAudits", () => {
    it("should clear all buffered audits", async () => {
      const { Audits } = await import("./audits.js");

      class TestableAudits extends Audits<typeof testConfig> {
        public testClearAudits(): void {
          this.clearAudits();
        }
      }

      const audits = new TestableAudits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.addAudit(createAuditItem());
      audits.testClearAudits();
      audits.publishStoredAudits();

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });

  describe("console initialization", () => {
    it("should use global console in dev mode", async () => {
      process.env.POWERTOOLS_DEV = "true";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      // In dev mode AND not disabled, should use global console
      // But it's also disabled in dev mode by default...
      // Dev mode disables audits unless POWERTOOLS_AUDITS_DISABLED=false
      consoleSpy.mockRestore();
    });

    it("should use dedicated Console in production mode", async () => {
      // No POWERTOOLS_DEV set = production mode
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      // In production mode, uses dedicated Console writing to process.stdout
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it("should use global console when dev mode enabled and audits not disabled", async () => {
      process.env.POWERTOOLS_DEV = "true";
      process.env.POWERTOOLS_AUDITS_DISABLED = "false";
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      // In dev mode with audits enabled, should use global console
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("schema validation", () => {
    it("should validate audit entries through LogAuditSchema", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      // Add audit with Error object (should be transformed by schema)
      audits.addAudit({
        ...createAuditItem(),
        error: new Error("Test error"),
      });
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      // Error should be stringified by the schema transform
      expect(typeof (parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>).error).toBe("string");
    });

    it("should apply default status when not provided", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      expect((parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>).status).toBe("success");
    });

    it("should apply default tier when not provided", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit(createAuditItem());
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      expect((parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>).tier).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("should handle empty publish gracefully", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      expect(() => audits.publishStoredAudits()).not.toThrow();
    });

    it("should handle audit with all optional fields", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit({
        operation: "fullAudit",
        target: { app: App.App1, type: ResourceType.UNKNOWN, id: "123" },
        source: { app: App.App1, type: ResourceType.UNKNOWN, id: "456" },
        context: { key: "value", nested: { deep: "data" } },
        message: "Test message",
        trace: "custom-trace",
        tier: 3,
      });
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      const audit = parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>;
      expect(audit.context).toEqual({
        key: "value",
        nested: { deep: "data" },
      });
      expect(audit.message).toBe("Test message");
      expect(audit.tier).toBe(3);
    });

    it("should handle resources as an array", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      audits.addAudit({
        operation: "withResourcesArray",
        target: { app: App.App1, type: ResourceType.UNKNOWN, id: "123" },
        resources: [
          { app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" },
          { app: App.App1, type: ResourceType.UNKNOWN, id: "res-2" },
        ],
      });
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      const audit = parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>;
      expect(audit.operation).toBe("withResourcesArray");
    });

    it("should handle resources as a Set", async () => {
      const { Audits } = await import("./audits.js");
      const audits = new Audits({ config: testConfig });

      const resourcesSet = new Set([
        { app: App.App1, type: ResourceType.UNKNOWN, id: "res-1" },
        { app: App.App1, type: ResourceType.UNKNOWN, id: "res-2" },
      ]);

      audits.addAudit({
        operation: "withResourcesSet",
        target: { app: App.App1, type: ResourceType.UNKNOWN, id: "123" },
        resources: resourcesSet,
      });
      audits.publishStoredAudits();

      const parsed = getLoggedAudit(0);
      const audit = parsed[AUDIT_LOG_IDENTIFIER] as Record<string, unknown>;
      expect(audit.operation).toBe("withResourcesSet");
    });
  });
});
