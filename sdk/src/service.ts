import type { Logger } from "@aws-lambda-powertools/logger";
import type { AuditConfig } from "./config.js";
import {
  AuditNotFoundError,
  InvalidNextTokenError,
  InvalidResourceFilterError,
  ReservedTenantError,
} from "./errors.js";
import { PutEventsError } from "./events/batch-handler.js";
import { AuditEventBus } from "./events/bus.js";
import {
  AuditRepository,
  type TypedIdentifiers,
  type TypedListByStatusOptions,
  type TypedListItemsOptions,
  type TypedListObjectsOptions,
  type TypedListTraceItems,
} from "./repository.js";
import type { Audit } from "./schema/audit.js";
import type { Pagination } from "./schema/model.js";
import { createTypedUpsertAuditSchema, type UpsertAuditInput } from "./schema/service.js";
import { generateAuditId } from "./utils.js";

export type {
  ListFilters,
  TypedIdentifiers,
  TypedResourceFilters,
  TypedListByStatusOptions,
  TypedListObjectsOptions,
  TypedListItemsOptions,
  TypedListTraceItems,
} from "./repository.js";

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
 *   apps: { Orders: ['Order'], Inventory: ['Product'] },
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
   * @throws {AuditNotFoundError} if the audit record is not found
   * @throws {ReservedTenantError} if the tenant id is `-`
   * @throws The underlying storage error if the lookup fails
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
      throw new AuditNotFoundError(identifiers);
    }

    return result;
  }

  /**
   * Creates or updates an audit record and its related resource entries.
   *
   * For each resource in the `resources` array that has an ID, writes a copy of the
   * audit's summary that lists it under that resource:
   * - The resource is the copy's target, and the audit's target its source
   * - It is the audit as stored: its id, its stored `createdAt`, and the fields a
   *   retry kept
   * - It inherits rerunable status from the audit or event presence
   *
   * When an audit with the same ID already exists (retry scenario):
   * - Appends the current execution to the `attempts` array
   * - Preserves the original `createdAt` timestamp
   * - Increments the attempt number automatically
   *
   * Attempts are system-managed: each call appends exactly one attempt. Any `attempts`
   * on `input` are accepted for backward compatibility but ignored.
   *
   * After storage, publishes an "Upserted" event to EventBridge (if events is configured).
   * Throttled or internally failed events are retried (see {@link AuditEventBus.upsertedOrThrow}).
   * If the event still isn't published, this logs at critical level with the message
   * `"Audit stored but Upserted event not published"` and the audit's identifiers, and does
   * not throw: the audit is already stored, and a throw would make callers upsert it again
   * and record an extra attempt.
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
    const parsed = schema.parse(input);
    const item = {
      ...parsed,
      id: parsed.id ?? generateAuditId(),
    };
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
    const { attemptNumber, audit } = await this.storage.upsertItem(item, currentAttempt);
    currentAttempt.number = attemptNumber;

    // A copy per related resource, of the audit as stored: with the fields a retry
    // kept, sorted with the audit by its stored createdAt
    await this.storage.upsertRelated(audit, item.resources);

    try {
      await this.events?.upsertedOrThrow([item]);
    } catch (error) {
      this.logger.critical("Audit stored but Upserted event not published", {
        tenantId: item.tenantId,
        id: item.id,
        app: item.target.app,
        target: {
          type: item.target.type,
          id: item.target.id,
        },
        failedEntries: error instanceof PutEventsError ? error.failedEntries : undefined,
        error,
      });
    }
  }

  /**
   * Lists audit records with filtering and pagination.
   *
   * Queries audits based on resource type and app, newest first.
   *
   * @param params - Query parameters for filtering
   * @param pagination - Optional pagination settings
   * @returns Paginated collection of audit records
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   * @throws {ReservedTenantError} if the tenant id is `-`
   * @throws Re-throws any storage errors after logging
   *
   * @example
   * ```typescript
   * const { items, pagination } = await service.listObjects({
   *   resource: { type: 'Order' },
   *   app: 'Orders',
   * });
   * ```
   */
  public async listObjects(params: TypedListObjectsOptions<C>, pagination?: Pagination) {
    try {
      return await this.storage.listObjects(params, pagination);
    } catch (error) {
      // A bad nextToken or tenant is the caller's mistake, not a storage failure.
      if (!isListingInputError(error)) {
        this.logger.error("An error occurred while trying to list objects", {
          error,
        });
      }

      throw error;
    }
  }

  /**
   * Lists audit records with filtering and pagination.
   *
   * Queries audits of a resource (app, resource type and id), newest first.
   *
   * @param params - Query parameters for filtering
   * @param pagination - Optional pagination settings
   * @returns Paginated collection of audit records
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   * @throws {ReservedTenantError} if the tenant id is `-`
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
      // A bad nextToken or tenant is the caller's mistake, not a storage failure.
      if (!isListingInputError(error)) {
        this.logger.error("An error occurred while trying to list items", {
          error,
        });
      }

      throw error;
    }
  }

  /**
   * Lists audit records by trace ID with pagination.
   *
   * Retrieves all audits associated with a distributed trace,
   * ordered by their stage in the processing pipeline, then oldest first.
   *
   * @param params - Query parameters including the trace ID
   * @param pagination - Optional pagination settings
   * @returns Paginated collection of trace-related audit records
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   * @throws {ReservedTenantError} if the tenant id is `-`
   * @throws {InvalidResourceFilterError} if a resource id filter lacks its app and type
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
      // A bad nextToken, filter or tenant is the caller's mistake, not a storage failure.
      if (!isListingInputError(error)) {
        this.logger.error("An error occurred while trying to list trace items", {
          error,
        });
      }

      throw error;
    }
  }

  /**
   * Lists audit records by status with date ordering and pagination.
   *
   * Retrieves all audits with a specific status (e.g., 'fail', 'warn'),
   * ordered by creation date (most recent first).
   * Supports optional filtering by app, resource type, and resource ID.
   *
   * @param params - Query parameters including status and optional filters
   * @param pagination - Optional pagination settings
   * @returns Paginated collection of status-filtered audit records
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   * @throws {ReservedTenantError} if the tenant id is `-`
   * @throws {InvalidResourceFilterError} if a resource id filter lacks its app and type
   * @throws Re-throws any storage errors after logging
   */
  public async listByStatus(params: TypedListByStatusOptions<C>, pagination?: Pagination) {
    try {
      return await this.storage.listByStatus(params, pagination);
    } catch (error) {
      // A bad nextToken, filter or tenant is the caller's mistake, not a storage failure.
      if (!isListingInputError(error)) {
        this.logger.error("An error occurred while trying to list items by status", {
          error,
        });
      }

      throw error;
    }
  }
}

/** Whether a listing failed on its input: a bad nextToken, resource filter or tenant. */
function isListingInputError(error: unknown): boolean {
  return (
    error instanceof InvalidNextTokenError ||
    error instanceof InvalidResourceFilterError ||
    error instanceof ReservedTenantError
  );
}
