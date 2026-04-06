import { Console } from "node:console";
import type { GenericLogger } from "@aws-lambda-powertools/commons/types";
import {
  getBooleanFromEnv,
  getXRayTraceIdFromEnv,
  isDevMode,
} from "@aws-lambda-powertools/commons/utils/env";
import type { AuditConfig } from "./config.js";
import { AUDIT_LOG_IDENTIFIER } from "./constants.js";
import { createTypedLogAuditSchema, type LogAuditInput } from "./schema/log.js";

/**
 * Maximum number of audit entries that can be buffered before automatic flush.
 * When this limit is reached, audits are automatically published to prevent memory issues.
 */
const MAX_AUDITS_SIZE = 20;

/**
 * Configuration options for the Audits class.
 */
export type AuditsOptions<C extends AuditConfig> = {
  /**
   * Custom logger for debug, warning, and error messages.
   * If not provided, a Console instance is used.
   * Note: Audit logs are always written to stdout regardless of this setting.
   */
  logger?: GenericLogger;
  /**
   * Audit configuration for strict typing of app and resourceType fields.
   * TypeScript will enforce correct app/type values at compile time and
   * runtime validation occurs against the config schemas.
   */
  config: C;
};

/**
 * Strictly typed audit input based on the provided config.
 * Replaces generic string types with the specific app and resourceType unions.
 */
export type StrictLogAuditInput<C extends AuditConfig> = Omit<
  LogAuditInput,
  "target" | "source" | "resources"
> & {
  target: {
    app: C["_types"]["App"];
    type: C["_types"]["ResourceType"];
    id?: string | number;
  };
  source?: {
    app: C["_types"]["App"];
    type: C["_types"]["ResourceType"];
    id?: string | number;
  };
  resources?:
    | Array<{
        app: C["_types"]["App"];
        type: C["_types"]["ResourceType"];
        id?: string | number;
      }>
    | Set<{
        app: C["_types"]["App"];
        type: C["_types"]["ResourceType"];
        id?: string | number;
      }>;
};

/**
 * Manages audit log collection and emission for AWS Lambda functions.
 *
 * Buffers audit entries and emits them as structured JSON logs to stdout,
 * which can be captured by CloudWatch Logs and processed by subscription filters.
 *
 * Features:
 * - Automatic buffering with configurable flush threshold
 * - X-Ray trace ID injection for distributed tracing
 * - Environment-based enable/disable control
 * - Schema validation via Zod before emission
 * - Strict typing for app and resourceType via config
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 *
 * const audits = new Audits({ config });
 *
 * audits.addAudit({
 *   operation: 'createOrder',
 *   target: { app: 'Orders', type: 'Order', id: '123' }, // Strictly typed!
 *   status: Status.SUCCESS,
 * });
 *
 * // Flush at end of Lambda execution
 * audits.publishStoredAudits();
 * ```
 */
export class Audits<C extends AuditConfig> {
  /**
   * Console instance for emitting audit logs to stdout.
   * Uses a dedicated Console instance in Lambda for isolation from custom loggers.
   * @internal
   */
  private console!: Console;

  /**
   * Logger for debug, warning, and error messages (not audit logs).
   */
  readonly logger: GenericLogger;

  /**
   * Whether audit emission is disabled.
   * @internal
   */
  private disabled = false;

  /**
   * Cached environment configuration values.
   * @internal
   */
  readonly #envConfig = {
    disabled: false,
    devMode: false,
  };

  /**
   * X-Ray trace ID from the Lambda environment, if available.
   * Automatically injected into audit entries that don't have a trace ID.
   */
  readonly traceId: string | undefined;

  /**
   * Buffer of audit entries waiting to be published.
   * @internal
   */
  private storedAudits: Array<LogAuditInput> = [];

  /**
   * Audit configuration for strict typing validation.
   * @internal
   */
  private readonly config: C;

  /**
   * Creates a new Audits instance.
   *
   * Initializes the console, reads environment configuration, and captures
   * the X-Ray trace ID from the Lambda environment.
   *
   * @param options - Configuration options including the required audit config
   */
  public constructor(options: AuditsOptions<C>) {
    this.setEnvConfig();
    this.setConsole();
    this.setDisabled();
    this.logger = options.logger || this.console;
    this.config = options.config;

    this.traceId = getXRayTraceIdFromEnv();
  }

  /**
   * Checks whether audit emission is currently disabled.
   *
   * @returns True if audits are disabled, false otherwise
   */
  protected isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Clears all buffered audit entries without publishing them.
   */
  protected clearAudits(): void {
    this.storedAudits = [];
  }

  /**
   * Adds an audit entry to the buffer.
   *
   * If the buffer reaches MAX_AUDITS_SIZE, automatically triggers
   * a flush to prevent unbounded memory growth.
   *
   * The input is validated against the config's schemas at runtime
   * and TypeScript enforces strict typing at compile time.
   *
   * @param item - The audit entry to buffer
   */
  public addAudit(item: StrictLogAuditInput<C>): void {
    if (Object.keys(this.storedAudits).length >= MAX_AUDITS_SIZE) {
      this.publishStoredAudits();
    }

    this.config.schemas.resourceReference.parse(item.target);
    if (item.source) {
      this.config.schemas.resourceReference.parse(item.source);
    }
    if (item.resources) {
      const resources = item.resources instanceof Set ? Array.from(item.resources) : item.resources;
      for (const resource of resources) {
        this.config.schemas.resourceReference.parse(resource);
      }
    }

    this.storedAudits.push(item as LogAuditInput);
  }

  /**
   * Publishes all buffered audit entries to stdout and clears the buffer.
   *
   * Each audit entry is:
   * 1. Injected with the X-Ray trace ID if not already set
   * 2. Validated and transformed through LogAuditSchema (or typed schema if config provided)
   * 3. Emitted as JSON with the AUDIT_LOG_IDENTIFIER wrapper
   *
   * If audits are disabled, the buffer is cleared without emission.
   *
   * @example
   * ```typescript
   * // Manual flush at end of handler
   * audits.publishStoredAudits();
   * ```
   */
  public publishStoredAudits(): void {
    if (!this.disabled) {
      const schema = createTypedLogAuditSchema(this.config.schemas.resourceReference);

      this.storedAudits.forEach((item) => {
        if (!item.trace) {
          item.trace = this.traceId;
        }

        this.console.log(
          JSON.stringify({
            [AUDIT_LOG_IDENTIFIER]: {
              ...schema.parse(item),
            },
          }),
        );
      });
    }

    this.clearAudits();
  }

  /**
   * Initializes the console instance based on environment mode.
   *
   * In production (non-dev mode), creates a dedicated Console instance
   * writing to process.stdout/stderr. In dev mode, uses the global console
   * for better local debugging experience.
   *
   * @internal
   */
  private setConsole(): void {
    if (!this.#envConfig.devMode) {
      this.console = new Console({
        stdout: process.stdout,
        stderr: process.stderr,
      });
    } else {
      this.console = console;
    }
  }

  /**
   * Reads and caches environment configuration values.
   *
   * Checks POWERTOOLS_AUDITS_DISABLED and POWERTOOLS_DEV environment
   * variables using AWS Lambda Powertools utilities.
   *
   * @internal
   */
  private setEnvConfig(): void {
    this.#envConfig.disabled = getBooleanFromEnv({
      key: "POWERTOOLS_AUDITS_DISABLED",
      defaultValue: false,
      extendedParsing: true,
    });
    this.#envConfig.devMode = isDevMode();
  }

  /**
   * Determines whether audits should be disabled based on environment.
   *
   * Priority:
   * 1. POWERTOOLS_AUDITS_DISABLED takes precedence if explicitly set
   * 2. Otherwise, audits are disabled in dev mode (POWERTOOLS_DEV=true)
   *
   * @internal
   */
  private setDisabled(): void {
    if (
      "POWERTOOLS_AUDITS_DISABLED" in process.env &&
      process.env.POWERTOOLS_AUDITS_DISABLED !== undefined
    ) {
      this.disabled = this.#envConfig.disabled;
      return;
    }
    this.disabled = this.#envConfig.devMode;
  }
}
