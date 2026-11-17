import type { Logger } from "@aws-lambda-powertools/logger";
import {
  BatchWriteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type { NativeAttributeValue } from "@aws-sdk/util-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { DEFAULT_TTL_SECONDS, type AuditConfig } from "./config.js";
import { DynamoDB, type IndexDefinition } from "./constants.js";
import { InvalidNextTokenError, InvalidResourceFilterError } from "./errors.js";
import {
  decodeNextPageToken,
  encodeNextPageToken,
  type PageKey,
  type PageKeySchema,
} from "./repository.utils.js";
import { type Audit, AuditSchema, AuditSummarySchema } from "./schema/audit.js";
import type { AnyTier, ResourceReference } from "./schema/common.js";
import type { AnyStatus } from "./schema/log.js";
import { type Pagination, PaginationCollectionSchema } from "./schema/model.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { type AuditStorage, AuditStorageSchema } from "./schema/storage.js";
import type { AnyApp, AnyResourceType, InferApp, InferResourceType } from "./types.js";
import { backoffDelay } from "./retry.js";
import { getTraceParts, hasResourceId } from "./utils.js";

const { Attributes, Indexes, Keys } = DynamoDB;

const MARSHALL_OPTIONS = {
  removeUndefinedValues: true,
  convertEmptyValues: true,
  convertClassInstanceToMap: true,
} as const;

/**
 * An index's LastEvaluatedKey: the table keys plus the index's own, with their
 * attribute types. A nextToken must decode to exactly these.
 */
const pageKeySchema = (index: IndexDefinition): PageKeySchema => ({
  [Keys.PARTITION_KEY]: "string",
  [Keys.SORT_KEY]: "string",
  ...Object.fromEntries(
    [...index.partitionKeys, ...index.sortKeys].map((key) => [key.name, key.type]),
  ),
});

/**
 * Decodes a listing's nextToken into its ExclusiveStartKey.
 *
 * DynamoDB rejects a start key outside the queried partition, so a token issued for
 * another resource, status, trace or tenant is refused here instead.
 *
 * @throws {InvalidNextTokenError} When the token isn't one this query could have returned
 */
function exclusiveStartKey(
  nextToken: string | null | undefined,
  index: IndexDefinition,
  partition: Record<string, string>,
): PageKey | undefined {
  const key = decodeNextPageToken(nextToken, pageKeySchema(index));
  if (key !== undefined && Object.entries(partition).some(([name, value]) => key[name] !== value)) {
    throw new InvalidNextTokenError();
  }

  return key;
}

/**
 * DynamoDB TTL attribute structure.
 */
export interface TTLAttribute {
  /** Unix timestamp in seconds when the item should expire */
  ttl: number;
}

/**
 * Generic type for unmarshalled DynamoDB attributes.
 */
export type UnmarshalledAttributes = { [key: string]: NativeAttributeValue };

/**
 * DynamoDB primary key structure: the audit's partition, and `audit` or a
 * related-resource copy's sort key.
 */
type DynamoDBPrimaryKey = {
  [DynamoDB.Keys.PARTITION_KEY]: string;
  [DynamoDB.Keys.SORT_KEY]: string;
};

/**
 * The top-level attributes the index keys are built from.
 */
export type IndexAttributes = {
  tenantKey: string;
  app: string;
  resourceType: string;
  resourceId?: string;
  kind: (typeof DynamoDB.Kinds)[keyof typeof DynamoDB.Kinds];
  traceId?: string;
  traceStage?: number;
};

/**
 * Identifiers used to locate audit records in DynamoDB.
 * Used for constructing primary and secondary keys.
 */
export type Identifiers = {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
  /** Unique audit record identifier */
  id: string | number;
  /** Application that owns this audit record */
  app: AnyApp;
  /** Optional resource identifier within the application */
  resourceId?: string | number;
  /** Type of resource being audited */
  resourceType: AnyResourceType;
};

/**
 * Generic identifiers with typed App and ResourceType from config.
 * @typeParam C - The audit config type for type inference
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
 * Filters every listing takes. They're applied as a DynamoDB filter expression,
 * after a page is read, so a filtered page can hold fewer items than its size
 * (or none) while a nextToken continues the listing.
 */
export type ListFilters = {
  /** Only audits of this operation (exact match) */
  operation?: string;
  /** Only audits of this tier */
  tier?: AnyTier;
};

/**
 * Filters on the audit's resources, for the status and trace listings. They match
 * the audit's target or any of its related resources. A resource id is matched only
 * together with its app and type.
 * @typeParam C - The audit config type for type inference
 */
export type TypedResourceFilters<C extends AuditConfig> = {
  /** Optional application filter */
  app?: InferApp<C>;
  /** Optional resource filter */
  resource?: {
    /** Filter by resource type */
    type?: InferResourceType<C>;
    /** Filter by resource ID; needs `app` and `resource.type` */
    id?: string | number;
  };
};

/**
 * Options for listing audit objects by resource with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListObjectsOptions<C extends AuditConfig> = ListFilters & {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
  /** Resource identification */
  resource: {
    /** Type of the resource */
    type: InferResourceType<C>;
  };
  /** Application owning the resource */
  app: InferApp<C>;
};

/**
 * Options for listing audit items by resource with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListItemsOptions<C extends AuditConfig> = Omit<
  TypedListObjectsOptions<C>,
  "resource"
> & {
  resource: {
    /** Type of the resource */
    type: InferResourceType<C>;
    /** Unique identifier of the resource */
    id: string | number;
  };
};

/**
 * Options for listing audit items by trace ID with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListTraceItems<C extends AuditConfig> = ListFilters &
  TypedResourceFilters<C> & {
    /** Tenant/organization identifier for multi-tenancy support (optional) */
    tenantId?: string;
    /** Trace ID to query for related audit records */
    trace: string;
  };

/**
 * Options for listing audit items by status with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListByStatusOptions<C extends AuditConfig> = ListFilters &
  TypedResourceFilters<C> & {
    /** Tenant/organization identifier for multi-tenancy support (optional) */
    tenantId?: string;
    /** Status to filter by (success, warn, fail, skip) */
    status: AnyStatus;
  };

/**
 * What an audit's `scopes` attribute holds for one of its resources: everything a
 * resource filter can name it by.
 *
 * @internal
 */
export function resourceScopes(resource: ResourceReference): string[] {
  const scopes = [resource.app, `${resource.app}.${resource.type}`, `*.${resource.type}`];
  if (hasResourceId(resource.id)) {
    scopes.push(`${resource.app}.${resource.type}#${resource.id}`);
  }
  return scopes;
}

/**
 * The `scopes` value a resource filter matches.
 *
 * @throws {InvalidResourceFilterError} When a resource id is given without its app and type
 * @internal
 */
export function filterScope(filters: {
  app?: string;
  resource?: { type?: string; id?: string | number };
}): string | undefined {
  const { app, resource } = filters;

  if (hasResourceId(resource?.id)) {
    if (!app || !resource.type) {
      throw new InvalidResourceFilterError();
    }
    return `${app}.${resource.type}#${resource.id}`;
  }

  if (app && resource?.type) return `${app}.${resource.type}`;
  if (app) return app;
  if (resource?.type) return `*.${resource.type}`;
  return undefined;
}

/**
 * Builds a listing's filter expression from its filters.
 *
 * @param filters - Operation, tier and the `scopes` value to match, each optional
 * @returns The expression with its names and values, or undefined when nothing filters
 * @internal
 */
function buildFilter(filters: ListFilters & { scope?: string }) {
  const conditions: string[] = [];
  const ExpressionAttributeNames: Record<string, string> = {};
  const ExpressionAttributeValues: UnmarshalledAttributes = {};

  if (filters.operation !== undefined) {
    conditions.push("#operation = :operation");
    ExpressionAttributeNames["#operation"] = "operation";
    ExpressionAttributeValues[":operation"] = filters.operation;
  }

  if (filters.tier !== undefined) {
    conditions.push("#tier = :tier");
    ExpressionAttributeNames["#tier"] = "tier";
    ExpressionAttributeValues[":tier"] = filters.tier;
  }

  if (filters.scope !== undefined) {
    conditions.push("contains(#scopes, :scope)");
    ExpressionAttributeNames["#scopes"] = Attributes.SCOPES;
    ExpressionAttributeValues[":scope"] = filters.scope;
  }

  if (conditions.length === 0) {
    return undefined;
  }

  return {
    FilterExpression: conditions.join(" AND "),
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  };
}

/** The tenant part of every index key */
const tenantKey = (tenantId?: string) => tenantId || DynamoDB.NO_TENANT;

/**
 * Constructs the DynamoDB primary key of an audit.
 *
 * When tenantId is provided, it prefixes the partition key for multi-tenant isolation.
 *
 * @param identifiers - Object containing tenantId (optional), app, id, and resourceType
 * @returns Primary key object with PK and SK attributes
 * @internal
 */
export function constructPrimaryKey({
  tenantId,
  app,
  id,
  resourceType,
}: Omit<Identifiers, "resourceId">): DynamoDBPrimaryKey {
  const pkBase = `${app}.${resourceType}#${id}`;
  return {
    [Keys.PARTITION_KEY]: tenantId ? `${tenantId}#${pkBase}` : pkBase,
    [Keys.SORT_KEY]: DynamoDB.SortKeys.AUDIT,
  };
}

/**
 * The sort key of an audit's copy under a related resource.
 *
 * @internal
 */
export function relatedSortKey(resource: ResourceReference): string {
  return `${DynamoDB.SortKeys.RELATED_PREFIX}${resource.app}.${resource.type}#${resource.id}`;
}

/**
 * Constructs the top-level attributes the index keys are built from.
 *
 * The resource id is stored as a string, so numeric and string ids list together.
 * Only audits get the trace attributes, which keeps copies out of `ByTrace`.
 *
 * @param item - The audit, or a related-resource copy
 * @param kind - Whether the item is the audit or a copy
 * @returns The index attributes
 * @internal
 */
export function constructIndexAttributes(
  item: Pick<AuditStorage, "tenantId" | "target" | "trace">,
  kind: IndexAttributes["kind"],
): IndexAttributes {
  const trace = kind === DynamoDB.Kinds.AUDIT && item.trace ? getTraceParts(item.trace) : undefined;

  return {
    tenantKey: tenantKey(item.tenantId),
    app: item.target.app,
    resourceType: item.target.type,
    // A numeric id of 0 is an id; only a missing or empty one is left out
    ...(hasResourceId(item.target.id) ? { resourceId: String(item.target.id) } : {}),
    kind,
    ...(trace ? { traceId: trace.id, traceStage: trace.stage } : {}),
  };
}

/**
 * Repository for managing audit records in DynamoDB.
 *
 * Provides CRUD operations for audit records with support for:
 * - Single item retrieval by identifiers
 * - Atomic upserts with attempt tracking, plus a copy per related resource
 * - Paginated listing by resource type, resource, status and trace, newest first
 *
 * See {@link DynamoDB} for the table's items and indexes. Listings return
 * {@link AuditSummarySchema summaries}; {@link getItem} returns the whole audit.
 *
 * @typeParam C - The audit config type for type inference
 *
 * @example
 * ```typescript
 * const config = defineAuditConfig({
 *   apps: ['Orders', 'Inventory'] as const,
 *   resourceTypes: ['Order', 'Product'] as const,
 * });
 * const repository = new AuditRepository(logger, config);
 *
 * // Get a single audit record - typed!
 * const audit = await repository.getItem({
 *   id: 'audit-123',
 *   app: 'Orders',           // TypeScript knows valid values
 *   resourceType: 'Order',   // Autocomplete works
 * });
 *
 * // List audits for a specific resource
 * const { items, pagination } = await repository.listItems({
 *   app: 'Orders',
 *   resource: { type: 'Order', id: 'order-123' },
 * });
 * ```
 */
export class AuditRepository<C extends AuditConfig> {
  /**
   * Creates a new AuditRepository instance.
   *
   * @param logger - Logger instance for error reporting and debugging
   * @param config - Audit configuration for type inference
   * @param client - DynamoDB client (defaults to new instance with AWS_REGION from environment)
   */
  public constructor(
    private readonly logger: Logger,
    private readonly config: C,
    private readonly client: DynamoDBClient = new DynamoDBClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      logger,
    }),
  ) {}

  /**
   * Retrieves a single audit record by its identifiers.
   *
   * Performs a DynamoDB GetItem operation using the constructed primary key.
   * Returns undefined only when DynamoDB returns no item. DynamoDB errors and
   * items that fail schema parsing are logged and rethrown.
   *
   * @param identifiers - Object containing id, app, and resourceType to locate the record
   * @returns The audit record if found, undefined otherwise
   * @throws The underlying error if the DynamoDB request or schema parsing fails
   *
   * @example
   * ```typescript
   * const audit = await repository.getItem({
   *   id: 'audit-123',
   *   app: 'Orders',
   *   resourceType: 'Order',
   * });
   *
   * if (audit) {
   *   console.log('Found audit:', audit.operation);
   * }
   * ```
   */
  public async getItem(
    identifiers: Omit<TypedIdentifiers<C>, "resourceId">,
  ): Promise<Audit | undefined> {
    try {
      const { Item: item } = await this.client.send(
        new GetItemCommand({
          TableName: DynamoDB.Table.Name(),
          Key: marshall(constructPrimaryKey(identifiers), MARSHALL_OPTIONS),
        }),
      );

      return item ? AuditSchema.parse(withoutNullTrace(unmarshall(item))) : undefined;
    } catch (error) {
      this.logger.error("Failed to read audit item", {
        identifiers,
        error,
      });

      throw error;
    }
  }

  /**
   * Upserts a single audit record with atomic attempt tracking.
   *
   * Uses DynamoDB UpdateItem with conditional expressions to:
   * - Create a new item if it doesn't exist (with attempts = [currentAttempt])
   * - Append to existing attempts array if item exists
   * - Preserve original createdAt timestamp on updates, so a retried audit keeps its
   *   place in every listing
   *
   * This is atomic and race-condition safe for retry tracking.
   *
   * Attempts are system-managed: each call appends exactly one attempt (`currentAttempt`).
   * Any `attempts` on `item` are ignored; they are neither written nor appended.
   *
   * @param item - The audit record to upsert (its `attempts`, if any, are ignored)
   * @param currentAttempt - The current attempt to append
   * @returns The attempt number (1 for new items, incremented for existing) and the
   *   stored `createdAt`
   *
   * @example
   * ```typescript
   * const { attemptNumber, createdAt } = await repository.upsertItem(
   *   { operation: 'processPayment', status: 'success', ... },
   *   { number: 1, status: 'success', at: '2024-01-01T00:00:00Z' }
   * );
   * ```
   */
  public async upsertItem(
    item: UpsertAuditInput,
    currentAttempt: {
      number: number;
      status: string;
      error?: unknown;
      at: string;
    },
  ): Promise<{ attemptNumber: number; createdAt: string }> {
    const now = new Date();

    const payload = AuditStorageSchema.parse({
      createdAt: now,
      ...item,
      updatedAt: now,
    });

    const primaryKey = constructPrimaryKey({
      tenantId: payload.tenantId,
      id: payload.id,
      resourceType: payload.target.type,
      app: payload.target.app,
    });

    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {
      ":emptyList": [],
      ":newAttempt": [currentAttempt],
    };
    const setClauses: string[] = [
      "#attempts = list_append(if_not_exists(#attempts, :emptyList), :newAttempt)",
      "#createdAt = if_not_exists(#createdAt, :createdAt)",
    ];
    expressionAttributeNames["#attempts"] = "attempts";
    expressionAttributeNames["#createdAt"] = "createdAt";

    // Added to, not replaced: a copy under a resource a retry no longer lists stays,
    // so the status and trace filters keep matching that resource too
    expressionAttributeNames["#scopes"] = Attributes.SCOPES;
    expressionAttributeValues[":scopes"] = new Set(
      [payload.target, ...(item.resources ?? [])].flatMap(resourceScopes),
    );

    // Add all payload fields dynamically
    const allFields: Record<string, unknown> = {
      ...payload,
      ...constructIndexAttributes(payload, DynamoDB.Kinds.AUDIT),
      ttl: this.constructTTLAttribute(this.config.ttlSeconds).ttl,
    };

    // Caller-supplied attempts are ignored; the list_append clause above owns the field.
    // Adding them would leave an unused `:attempts` value, which DynamoDB rejects.
    const ignoredFields = new Set(["attempts"]);

    // Fields that already have a clause in setClauses; their values still feed it (`:createdAt`)
    const specialFields = new Set(["createdAt"]);

    for (const [key, value] of Object.entries(allFields)) {
      if (value === undefined || ignoredFields.has(key)) continue;

      expressionAttributeNames[`#${key}`] = key;
      expressionAttributeValues[`:${key}`] = value;

      if (!specialFields.has(key)) {
        setClauses.push(`#${key} = :${key}`);
      }
    }

    const result = await this.client.send(
      new UpdateItemCommand({
        TableName: DynamoDB.Table.Name(),
        Key: marshall(primaryKey, MARSHALL_OPTIONS),
        UpdateExpression: `SET ${setClauses.join(", ")} ADD #scopes :scopes`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues, MARSHALL_OPTIONS),
        ReturnValues: "ALL_NEW",
      }),
    );

    if (!result.Attributes) {
      throw new Error("UpdateItem did not return attributes");
    }
    const updated = unmarshall(result.Attributes) as { attempts: unknown[]; createdAt: string };
    const attemptNumber = updated.attempts.length;

    if (attemptNumber !== currentAttempt.number) {
      await this.client.send(
        new UpdateItemCommand({
          TableName: DynamoDB.Table.Name(),
          Key: marshall(primaryKey, MARSHALL_OPTIONS),
          UpdateExpression: `SET #attempts[${attemptNumber - 1}].#number = :attemptNumber`,
          ExpressionAttributeNames: {
            "#attempts": "attempts",
            "#number": "number",
          },
          ExpressionAttributeValues: marshall({
            ":attemptNumber": attemptNumber,
          }),
        }),
      );
    }

    return { attemptNumber, createdAt: updated.createdAt };
  }

  /**
   * Writes the copy of an audit that lists it under each related resource with an id.
   *
   * A copy holds the audit's summary, with the resource as `target` and the audit's
   * target as `source`, in the audit's partition (`SK`
   * `related#{app}.{type}#{resourceId}`). It takes the audit's stored `createdAt`, so
   * it sorts with the audit. Each upsert rewrites the copies of the resources it
   * lists, once per resource; a copy under a resource a retry no longer lists stays,
   * as do that resource's `scopes` on the audit. Items are written with
   * BatchWriteItem, 25 at a time.
   *
   * @param item - The audit, with its id
   * @param createdAt - The audit's stored `createdAt`, from {@link upsertItem}
   * @throws Error if unprocessed items remain after the maximum retries
   *
   * @example
   * ```typescript
   * const { createdAt } = await repository.upsertItem(item, attempt);
   * await repository.upsertRelated(item, createdAt);
   * ```
   */
  public async upsertRelated(
    item: UpsertAuditInput & { id: string },
    createdAt: string,
  ): Promise<void> {
    const BATCH_SIZE = 25;

    const payload = AuditStorageSchema.parse({ ...item, createdAt, updatedAt: new Date() });
    const primaryKey = constructPrimaryKey({
      tenantId: payload.tenantId,
      id: payload.id,
      resourceType: payload.target.type,
      app: payload.target.app,
    });
    const summary = AuditSummarySchema.parse(payload);
    const ttl = this.constructTTLAttribute(this.config.ttlSeconds);

    // One copy per resource: a BatchWriteItem can't put the same key twice. The last
    // listing of a resource wins, as it would have if each were written in turn
    const resources = new Map(
      Array.from(item.resources ?? [])
        .filter((resource) => hasResourceId(resource.id))
        .map((resource) => [relatedSortKey(resource), resource]),
    );

    const requests: WriteRequest[] = Array.from(resources, ([sortKey, resource]) => {
      const target = { app: resource.app, type: resource.type, id: resource.id };
      const copy = {
        ...summary,
        target,
        source: payload.target,
        rerunable: payload.rerunable ?? !!payload.event,
      };

      return {
        PutRequest: {
          Item: marshall(
            {
              [Keys.PARTITION_KEY]: primaryKey.PK,
              [Keys.SORT_KEY]: sortKey,
              ...copy,
              ...constructIndexAttributes(copy, DynamoDB.Kinds.RELATED),
              ...ttl,
            },
            MARSHALL_OPTIONS,
          ),
        },
      };
    });

    // Sequentially, to reduce the risk of triggering more throttling
    for (let i = 0; i < requests.length; i += BATCH_SIZE) {
      await this.writeBatchWithRetry(requests.slice(i, i + BATCH_SIZE), DynamoDB.Table.Name());
    }
  }

  /**
   * Sends a batch request, resending its unprocessed part with exponential backoff.
   *
   * DynamoDB's batch operations can return unprocessed items when throttled or under
   * transient errors without throwing an exception. This method retries them automatically.
   *
   * @param label - Operation and item noun for logs and errors (e.g. `BatchWriteItem`, `items`)
   * @param request - The first request to send
   * @param send - Sends a request and returns its unprocessed part with its size, or
   *   undefined when everything was processed
   * @param maxRetries - Maximum number of retry attempts (default: 8)
   * @param baseDelayMs - Delay ceiling in milliseconds before the first retry, doubling after
   *   each; the delay is jittered (see {@link backoffDelay}) (default: 100)
   * @throws Error if unprocessed items remain after maxRetries attempts
   * @internal
   */
  private async sendBatchWithRetry<R>(
    label: { operation: string; noun: string },
    request: R,
    send: (request: R) => Promise<{ unprocessed: R; count: number } | undefined>,
    maxRetries = 8,
    baseDelayMs = 100,
  ): Promise<void> {
    let attempt = 0;

    for (;;) {
      const remaining = await send(request);
      if (!remaining) {
        return; // all items processed
      }

      attempt++;
      if (attempt > maxRetries) {
        this.logger.error(
          `${label.operation}: unprocessed ${label.noun} remain after max retries`,
          {
            unprocessed: remaining.unprocessed,
            attempt,
          },
        );
        throw new Error(
          `${label.operation} failed: unprocessed ${label.noun} after ${maxRetries} retries`,
        );
      }

      const delayMs = backoffDelay(attempt, baseDelayMs);
      this.logger.warn(`${label.operation}: retrying unprocessed ${label.noun}`, {
        count: remaining.count,
        attempt,
        delayMs,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      request = remaining.unprocessed;
    }
  }

  /**
   * Writes a batch of items to DynamoDB, retrying unprocessed items with exponential backoff.
   *
   * @param items - Array of WriteRequests to send
   * @param tableName - Target DynamoDB table name
   * @throws Error if unprocessed items remain after the maximum retries
   * @internal
   */
  private async writeBatchWithRetry(items: WriteRequest[], tableName: string): Promise<void> {
    await this.sendBatchWithRetry(
      { operation: "BatchWriteItem", noun: "items" },
      { [tableName]: items },
      async (RequestItems) => {
        const { UnprocessedItems: unprocessed } = await this.client.send(
          new BatchWriteItemCommand({ RequestItems }),
        );

        return unprocessed && Object.keys(unprocessed).length > 0
          ? {
              unprocessed: unprocessed as Record<string, WriteRequest[]>,
              count: Object.values(unprocessed).flat().length,
            }
          : undefined;
      },
    );
  }

  /**
   * Lists the audits of a resource type, newest first, with pagination.
   *
   * Queries the `ByType` index. The listing includes audits that name a resource of
   * this type as a related resource, with that resource as `target` and the audit's
   * own target as `source`.
   *
   * @param params - App, resource type and optional filters
   * @param pagination - Optional pagination settings (pageSize, nextToken)
   * @returns Paginated collection of audit summaries
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   */
  public async listObjects(params: TypedListObjectsOptions<C>, pagination?: Pagination) {
    return this.listIndex(
      Indexes.BY_TYPE,
      {
        [Attributes.TENANT_KEY]: tenantKey(params.tenantId),
        [Attributes.APP]: params.app,
        [Attributes.RESOURCE_TYPE]: params.resource.type,
      },
      { forward: false, filters: params, pagination },
    );
  }

  /**
   * Lists the audits of a resource, newest first, with pagination.
   *
   * Queries the `ByResource` index. Like {@link listObjects}, it includes audits that
   * name the resource as a related resource.
   *
   * @param params - App, resource type and id, and optional filters
   * @param pagination - Optional pagination settings (pageSize, nextToken)
   * @returns Paginated collection of audit summaries
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   *
   * @example
   * ```typescript
   * // Get first page
   * const page1 = await repository.listItems({
   *   app: 'Orders',
   *   resource: { type: 'Order', id: 'order-123' },
   * });
   *
   * // Get next page using the pagination token
   * const page2 = await repository.listItems(
   *   { app: 'Orders', resource: { type: 'Order', id: 'order-123' } },
   *   { nextToken: page1.pagination?.nextToken },
   * );
   * ```
   */
  public async listItems(params: TypedListItemsOptions<C>, pagination?: Pagination) {
    return this.listIndex(
      Indexes.BY_RESOURCE,
      {
        [Attributes.TENANT_KEY]: tenantKey(params.tenantId),
        [Attributes.APP]: params.app,
        [Attributes.RESOURCE_TYPE]: params.resource.type,
        [Attributes.RESOURCE_ID]: String(params.resource.id),
      },
      { forward: false, filters: params, pagination },
    );
  }

  /**
   * Lists audit records by trace ID for distributed tracing.
   *
   * Queries the `ByTrace` index: audits sharing the trace id, by stage, then
   * oldest first. Resource filters match an audit's target or any of its
   * related resources.
   *
   * @param params - Query parameters including trace ID and optional filters
   * @param pagination - Optional pagination settings (pageSize, nextToken)
   * @returns Paginated collection of audit summaries in trace order
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   * @throws {InvalidResourceFilterError} if a resource id filter is given without its app and type
   *
   * @example
   * ```typescript
   * // Get all audits for a trace
   * const trace = await repository.listTraceItems({
   *   trace: 'trace-abc-123',
   * });
   *
   * // Filter by app and resource type
   * const filtered = await repository.listTraceItems({
   *   trace: 'trace-abc-123',
   *   app: 'Orders',
   *   resource: { type: 'Order' },
   * });
   * ```
   */
  public async listTraceItems(params: TypedListTraceItems<C>, pagination?: Pagination) {
    return this.listIndex(
      Indexes.BY_TRACE,
      {
        [Attributes.TENANT_KEY]: tenantKey(params.tenantId),
        [Attributes.TRACE_ID]: params.trace,
      },
      { forward: true, filters: { ...params, scope: filterScope(params) }, pagination },
    );
  }

  /**
   * Lists audit records by status, newest first, with optional filters.
   *
   * Queries the `ByStatus` index, which holds audits only, not their related-resource
   * copies. Resource filters match an audit's target or any of its related resources.
   *
   * @param params - Query parameters including status and optional filters
   * @param pagination - Optional pagination settings (pageSize, nextToken)
   * @returns Paginated collection of audit summaries
   * @throws {InvalidNextTokenError} if `pagination.nextToken` isn't one this listing returned
   * @throws {InvalidResourceFilterError} if a resource id filter is given without its app and type
   */
  public async listByStatus(params: TypedListByStatusOptions<C>, pagination?: Pagination) {
    return this.listIndex(
      Indexes.BY_STATUS,
      {
        [Attributes.TENANT_KEY]: tenantKey(params.tenantId),
        [Attributes.STATUS]: params.status,
        [Attributes.KIND]: DynamoDB.Kinds.AUDIT,
      },
      { forward: false, filters: { ...params, scope: filterScope(params) }, pagination },
    );
  }

  /**
   * Reads a page of an index partition as audit summaries.
   *
   * @param index - The index to query
   * @param partition - Every partition key attribute of the index, with its value
   * @param options - Sort direction, filters and pagination
   * @internal
   */
  private async listIndex(
    index: IndexDefinition,
    partition: Record<string, string>,
    options: {
      forward: boolean;
      filters: ListFilters & { scope?: string };
      pagination?: Pagination;
    },
  ) {
    const pageSize = Number(options.pagination?.pageSize || 100);
    const startKey = exclusiveStartKey(options.pagination?.nextToken, index, partition);
    const filter = buildFilter(options.filters);

    const names = Object.keys(partition);
    const { Items: items, LastEvaluatedKey: lastEvaluatedKey } = await this.client.send(
      new QueryCommand({
        TableName: DynamoDB.Table.Name(),
        IndexName: index.name,
        ScanIndexForward: options.forward,
        KeyConditionExpression: names.map((_, i) => `#k${i} = :k${i}`).join(" AND "),
        ExpressionAttributeNames: {
          ...Object.fromEntries(names.map((name, i) => [`#k${i}`, name])),
          ...filter?.ExpressionAttributeNames,
        },
        ExpressionAttributeValues: marshall({
          ...Object.fromEntries(names.map((name, i) => [`:k${i}`, partition[name]])),
          ...filter?.ExpressionAttributeValues,
        }),
        FilterExpression: filter?.FilterExpression,
        Limit: pageSize,
        ExclusiveStartKey: startKey ? marshall(startKey) : undefined,
      }),
    );

    return PaginationCollectionSchema(AuditSummarySchema).parse({
      items: (items ?? []).map((item) => withoutNullTrace(unmarshall(item))),
      pagination: {
        nextToken: lastEvaluatedKey ? encodeNextPageToken(unmarshall(lastEvaluatedKey)) : undefined,
      },
    });
  }

  /**
   * Constructs the TTL attribute for automatic item expiration.
   *
   * @param ttlSeconds - Seconds until expiration (defaults to 90 days)
   * @param date - Base date for TTL calculation (defaults to now)
   * @returns TTL attribute with Unix timestamp in seconds
   * @internal
   */
  private constructTTLAttribute(
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
    date?: Date,
  ): TTLAttribute {
    // Epoch arithmetic: Date#setSeconds works in local time, so 90 days across a
    // daylight saving change landed an hour off outside UTC.
    return {
      ttl: Math.floor((date ?? new Date()).valueOf() / 1000) + ttlSeconds,
    };
  }
}

/**
 * Drops a `trace` that isn't a string. An empty trace is written as NULL
 * (`convertEmptyValues`), which the schemas don't accept.
 *
 * @internal
 */
function withoutNullTrace(item: UnmarshalledAttributes): UnmarshalledAttributes {
  if (typeof item.trace === "string") {
    return item;
  }

  const { trace: _, ...rest } = item;
  return rest;
}
