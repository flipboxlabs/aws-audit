import type { Logger } from "@aws-lambda-powertools/logger";
import type { AuditConfig } from "./config.js";
import { AuditEventBus } from "./events/bus.js";
import { AuditRepository } from "./repository.js";
import type { Audit } from "./schema/audit.js";
import type { Pagination } from "./schema/model.js";
import { createTypedUpsertAuditSchema, type UpsertAuditInput } from "./schema/service.js";
import type { InferApp, InferResourceType } from "./types.js";

/**
 * Typed identifiers for locating audit records.
 * Uses config-derived App and ResourceType types for strict typing.
 */
export type TypedIdentifiers<C extends AuditConfig> = {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
  /** Unique audit record identifier */
  id: string | number;
  /** Application that owns this audit record */
  app: InferApp<C>;
  /** Optional resource identifier within the application */
  resourceId?: string | number;
  /** Type of resource being audited */
  resourceType: InferResourceType<C>;
};

/**
 * Typed options for listing audit items by resource.
 * Uses config-derived App and ResourceType types for strict typing.
 */
export type TypedListItemsOptions<C extends AuditConfig> = {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
  /** Resource identification */
  resource: {
    /** Type of the resource */
    type: InferResourceType<C>;
    /** Unique identifier of the resource */
    id: string;
  };
  /** Application owning the resource */
  app: InferApp<C>;
};

/**
 * Typed options for listing audit items by trace ID.
 * Uses config-derived App and ResourceType types for strict typing.
 */
export type TypedListTraceItems<C extends AuditConfig> = {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
  /** Trace ID to query for related audit records */
  trace: string;
  /** Optional application filter */
  app?: InferApp<C>;
  /** Optional resource filter */
  resource?: {
    /** Filter by resource type */
    type?: InferResourceType<C>;
    /** Filter by resource ID */
    id?: string;
  };
};

/**
 * High-level service for managing audit records with typed App and ResourceType.
 *
 * Provides a business logic layer over the AuditRepository for CRUD operations
 * and coordinates with EventBridge for event-driven notifications.
 *
 * Features:
 * - Type-safe app and resourceType parameters derived from config
 * - Automatic creation of related resource audit entries
 * - Schema validation on upsert operations
 * - EventBridge integration for audit event notifications
 * - Paginated list queries with filtering
 *
 * @typeParam C - The audit config type for type inference
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 *
 * const service = new AuditService(logger, config);
 *
 * // Upsert an audit with related resources
 * await service.upsertItem({
 *   operation: 'createOrder',
 *   target: { app: 'Orders', type: 'Order', id: '123' },
 *   resources: [
 *     { app: 'Inventory', type: 'Product', id: '456' },
 *   ],
 * });
 *
 * // Retrieve a specific audit - app and resourceType are typed!
 * const audit = await service.getItem({
 *   id: 'audit-123',
 *   app: 'Orders',        // TypeScript knows valid values
 *   resourceType: 'Order', // Autocomplete works
 * });
 * ```
 */
export class AuditService<C extends AuditConfig> {
  private readonly storage: AuditRepository<C>;
  private readonly config: C;

  /**
   * Creates a new AuditService instance.
   *
   * @param logger - Logger instance for error logging
   * @param config - Audit configuration for type inference
   * @param storage - Repository for DynamoDB operations (defaults to new AuditRepository)
   * @param events - EventBridge bus for audit notifications (defaults to new AuditEventBus, can be null/undefined to disable)
   */
  constructor(
    private readonly logger: Logger,
    config: C,
    storage?: AuditRepository<C>,
    readonly events: null | undefined | AuditEventBus = new AuditEventBus(logger),
  ) {
    this.config = config;
    this.storage = storage ?? new AuditRepository(logger, config);
  }

  /**
   * Retrieves a single audit record by its identifiers.
   *
   * @param identifiers - The audit identifiers (id, app, resourceType)
   * @returns The audit record
   * @throws Error if the audit record is not found
   *
   * @example
   * ```typescript
   * const audit = await service.getItem({
   *   id: 'audit-123',
   *   app: 'MyApp',
   *   resourceType: 'User',
   * });
   * ```
   */
  public async getItem(identifiers: Omit<TypedIdentifiers<C>, "resourceId">): Promise<Audit> {
    const result = await this.storage.getItem(identifiers);

    if (result == null) {
      throw new Error(
        `Unable to find Audit ${Array.from(Object.entries(identifiers))
          .map(([key, value]) => `${key}:${value}`)
          .join(" | ")}`,
      );
    }

    return result;
  }

  /**
   * Creates or updates an audit record and its related resource entries.
   *
   * For each resource in the `resources` array that has an ID:
   * - Creates a separate audit entry with the resource as the target
   * - Links it to the parent audit via a generated composite ID
   * - Sets the original target as the source
   * - Inherits rerunable status from the parent or event presence
   *
   * When an audit with the same ID already exists (retry scenario):
   * - Appends the current execution to the `attempts` array
   * - Preserves the original `createdAt` timestamp
   * - Increments the attempt number automatically
   *
   * After storage, publishes an "Upserted" event to EventBridge (if events is configured).
   *
   * @param input - The audit data to upsert
   *
   * @example
   * ```typescript
   * await service.upsertItem({
   *   operation: 'processPayment',
   *   target: { app: 'Payments', type: 'Transaction', id: 'txn-123' },
   *   status: 'success',
   *   resources: [
   *     { app: 'Users', type: 'User', id: 'user-456' },
   *     { app: 'Orders', type: 'Order', id: 'order-789' },
   *   ],
   * });
   * ```
   */
  public async upsertItem(input: UpsertAuditInput): Promise<void> {
    const schema = createTypedUpsertAuditSchema(this.config.schemas.resourceReference);
    const item = schema.parse(input);
    const now = new Date().toISOString();

    // Build current attempt record
    const currentAttempt = {
      number: 1,
      status: item.status,
      error: item.error,
      at: now,
    };

    // Upsert main item with atomic attempt tracking
    // This handles both new items and retries in a single atomic operation
    const attemptNumber = await this.storage.upsertItem(item, currentAttempt);
    currentAttempt.number = attemptNumber;

    // Build batch for related resource items (these don't need retry tracking)
    const batch: Array<UpsertAuditInput> = Array.from(item.resources || [])
      .filter((resource) => !!resource.id)
      .map((resource) => ({
        ...item,
        ...resource,

        id: `${item.id}#${resource.app}.${resource.type}#${resource.id}`, // deterministic ID for retry correlation

        // Source
        source: item.target,

        rerunable: item.rerunable !== undefined ? item.rerunable : !!item.event,

        // Remove these (they are only needed on the parent)
        event: undefined,
        result: undefined,
        error: undefined,
        attempts: undefined,
      }));

    if (batch.length > 0) {
      await this.storage.upsertBatch(batch);
    }

    await this.events?.upserted([item]);
  }

  /**
   * Lists audit records with filtering and pagination.
   *
   * Queries audits based on resource type, app, and optional resource ID.
   * Results are paginated and can be filtered by various criteria.
   *
   * @param params - Query parameters for filtering
   * @param pagination - Optional pagination settings
   * @returns Paginated collection of audit records
   * @throws Re-throws any storage errors after logging
   *
   * @example
   * ```typescript
   * const { items, pagination } = await service.listItems({
   *   resource: { type: 'Order', id: '123' },
   *   app: 'Orders',
   * });
   * ```
   */
  public async listItems(params: TypedListItemsOptions<C>, pagination?: Pagination) {
    try {
      return await this.storage.listItems(params, pagination);
    } catch (error) {
      this.logger.error("An error occurred while trying to list items", {
        error,
      });

      throw error;
    }
  }

  /**
   * Lists audit records by trace ID with pagination.
   *
   * Retrieves all audits associated with a distributed trace,
   * ordered by their stage in the processing pipeline.
   *
   * @param params - Query parameters including the trace ID
   * @param pagination - Optional pagination settings
   * @returns Paginated collection of trace-related audit records
   * @throws Re-throws any storage errors after logging
   *
   * @example
   * ```typescript
   * const { items } = await service.listTraceItems({
   *   trace: 'trace-abc-123',
   * });
   * ```
   */
  public async listTraceItems(params: TypedListTraceItems<C>, pagination?: Pagination) {
    try {
      return await this.storage.listTraceItems(params, pagination);
    } catch (error) {
      this.logger.error("An error occurred while trying to list trace items", {
        error,
      });

      throw error;
    }
  }
}
