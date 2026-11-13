import type { Logger } from "@aws-lambda-powertools/logger";
import {
  BatchGetItemCommand,
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
import { DynamoDB } from "./constants.js";
import { decodeNextPageToken, encodeNextPageToken } from "./repository.utils.js";
import { type Audit, AuditPayloadSchema, AuditSchema } from "./schema/audit.js";
import type { AnyStatus } from "./schema/log.js";
import { type Pagination, PaginationCollectionSchema } from "./schema/model.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { type AuditStorage, AuditStorageSchema } from "./schema/storage.js";
import type { AnyApp, AnyResourceType, InferApp, InferResourceType } from "./types.js";
import { getTraceParts } from "./utils.js";

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

/** Resource type alias for DynamoDB key construction */
type ResourceType = AnyResourceType;

/** Resource identifier string type */
type ResourceId = string;

/** Audit record identifier type */
type Id = string;

/** Trace identifier type for distributed tracing */
type TraceId = string;

/** Tenant identifier type for multi-tenancy */
type TenantId = string;

/** DynamoDB partition key base format: {app}.{resourceType} */
type PKBase = `${AnyApp}.${ResourceType}`;

/** DynamoDB partition key format: optionally prefixed with {tenantId}# */
type PK = PKBase | `${TenantId}#${PKBase}`;

/** DynamoDB sort key format: {id} */
type SK = `${Id}`;

/**
 * DynamoDB primary key structure.
 * Uses composite key pattern with partition key (PK) and sort key (SK).
 */
type DynamoDBPrimaryKey = {
  [DynamoDB.Keys.PARTITION_KEY]: PK;
  [DynamoDB.Keys.SORT_KEY]: SK;
};

/** GSI partition key for trace queries: {traceId} or {tenantId}#{traceId} */
type TraceGSIPK = `${TraceId}` | `${TenantId}#${TraceId}`;
/** GSI sort key for trace queries: trace depth/stage number */
type TraceGSISK = number;

/**
 * DynamoDB GSI keys for trace-based queries.
 * Uses GSI1_SN (String-Number) index for trace lookups.
 */
type DynamoDBTraceGSIKeys = {
  [DynamoDB.Keys.GSI1_SN_PARTITION_KEY]?: TraceGSIPK;
  [DynamoDB.Keys.GSI1_SN_SORT_KEY]?: TraceGSISK;
};

/** GSI partition key base for resource listing: {app}.{resourceType}#{resourceId} or {app}.{resourceType} */
type GSI1PKBase = `${PKBase}#${ResourceId}` | PKBase;
/** GSI partition key for resource listing: optionally prefixed with {tenantId}# */
type GSI1PK = GSI1PKBase | `${TenantId}#${GSI1PKBase}`;
/** GSI sort key for resource listing: {id} */
type GSI1SK = `${Id}`;

/** Status value type for status-based queries */
type StatusValue = AnyStatus;

/** GSI2 partition key base for status queries: {status} */
type GSI2PKBase = `${StatusValue}`;
/** GSI2 partition key for status queries: optionally prefixed with {tenantId}# */
type GSI2PK = GSI2PKBase | `${TenantId}#${GSI2PKBase}`;
/** GSI2 sort key for status queries: {createdAt}#{id} for date ordering with uniqueness */
type GSI2SK = string;

/**
 * DynamoDB GSI keys for resource-based listing queries.
 * Uses GSI1_SS (String-String) index for resource lookups.
 */
type DynamoDBGSI1Keys = {
  [DynamoDB.Keys.GSI1_SS_PARTITION_KEY]: GSI1PK;
  [DynamoDB.Keys.GSI1_SS_SORT_KEY]: GSI1SK;
};

/**
 * DynamoDB GSI keys for status-based listing queries.
 * Uses GSI2_SS (String-String) index for status lookups with date ordering.
 */
type DynamoDBGSI2Keys = {
  [DynamoDB.Keys.GSI2_SS_PARTITION_KEY]: GSI2PK;
  [DynamoDB.Keys.GSI2_SS_SORT_KEY]: GSI2SK;
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
 * Combined secondary key structure for DynamoDB indexes.
 * Includes GSI keys for both string-string and string-number indexes,
 * plus LSI sort key for tier-based sorting.
 */
type SecondaryKeys = DynamoDBGSI1Keys &
  DynamoDBGSI2Keys &
  DynamoDBTraceGSIKeys & {
    [DynamoDB.Keys.LSI1_N_SORT_KEY]: number;
  };

/**
 * Complete DynamoDB item structure combining audit data with all keys.
 * Represents the full item as stored in DynamoDB.
 */
type DynamoDBItem = AuditStorage & TTLAttribute & DynamoDBPrimaryKey & SecondaryKeys;

/**
 * Subset of audit storage attributes used for listing operations.
 * Reduces data transfer by only including essential display fields.
 */
type ListingAttributes = Pick<
  AuditStorage,
  | "operation"
  | "status"
  | "message"
  | "source"
  | "target"
  | "rerunable"
  | "createdAt"
  | "updatedAt"
  | "attempts"
  | "error"
  | "event"
>;

/**
 * Non-key attributes the listing indexes project (see `cdk/src/dynamodb/audit.ts`).
 * Parent audits read from the table for a listing are limited to these, so they
 * have the same shape as rows read from the index.
 */
const LISTING_INDEX_ATTRIBUTES = [
  "operation",
  "status",
  "message",
  "source",
  "target",
  "rerunable",
  "createdAt",
] as const satisfies ReadonlyArray<keyof ListingAttributes>;

/**
 * Item structure returned from trace-based queries.
 * Includes listing attributes plus trace GSI keys for ordering.
 */
type TraceListingItem = ListingAttributes &
  Pick<DynamoDBPrimaryKey, "PK" | "SK"> &
  Pick<SecondaryKeys, "GSI1_SN_PK" | "GSI1_SN_SK">;

/**
 * Item structure returned from resource-based listing queries.
 * Extends trace listing with resource GSI keys.
 */
type ListingItem = TraceListingItem & Pick<SecondaryKeys, "GSI1_SS_PK" | "GSI1_SS_SK">;

/**
 * Item structure returned from status-based listing queries.
 * Includes listing attributes plus status GSI keys for ordering.
 */
type StatusListingItem = ListingAttributes &
  Pick<DynamoDBPrimaryKey, "PK" | "SK"> &
  Pick<SecondaryKeys, "GSI2_SS_PK" | "GSI2_SS_SK">;

/**
 * Options for listing audit objects by resource with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListObjectsOptions<C extends AuditConfig> = {
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
    id: string;
  };
};

/**
 * Options for listing audit items by trace ID with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
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
 * Options for listing audit items by status with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListByStatusOptions<C extends AuditConfig> = {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
  /** Status to filter by (success, warn, fail, skip) */
  status: AnyStatus;
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
 * Builds the filter shared by index listings that narrow on the audit target.
 *
 * App and resource values live on the nested `target` map (`target.app`,
 * `target.type`, `target.id`), so the filters address them through expression
 * attribute names. Audits recorded against additional resources carry a
 * compound sort key. Without a target filter they are excluded, so each audit
 * is listed once. With one they are kept, so an audit matches on any of its
 * resources; the listing maps them back to their parent with
 * {@link AuditRepository.resolveRelatedItems}.
 *
 * @param params - Optional app and resource filters
 * @returns Filter conditions plus the attribute names and values they reference
 * @internal
 */
function buildTargetFilter(params: { app?: string; resource?: { type?: string; id?: string } }) {
  const filters: string[] = [];
  const ExpressionAttributeValues: UnmarshalledAttributes = {};
  const ExpressionAttributeNames: Record<string, string> = {};

  if (params?.resource?.id) {
    Object.assign(ExpressionAttributeValues, {
      ":resourceId": params.resource.id,
    });
    ExpressionAttributeNames["#target"] = "target";
    ExpressionAttributeNames["#id"] = "id";
    filters.push("#target.#id = :resourceId");
  }

  if (params?.resource?.type) {
    Object.assign(ExpressionAttributeValues, {
      ":resourceType": params.resource.type,
    });
    ExpressionAttributeNames["#target"] = "target";
    ExpressionAttributeNames["#type"] = "type";
    filters.push("#target.#type = :resourceType");
  }

  if (params?.app) {
    Object.assign(ExpressionAttributeValues, {
      ":app": params.app,
    });
    ExpressionAttributeNames["#target"] = "target";
    ExpressionAttributeNames["#app"] = "app";
    filters.push("#target.#app = :app");
  }

  // Audits with other resources will have a compound id, filter these out unless a target
  // filter could match them (the listing maps them back to their parent)
  if (filters.length === 0) {
    Object.assign(ExpressionAttributeValues, { ":isParent": "#" });
    filters.push("not contains(SK, :isParent)");
  }

  return {
    FilterExpression: filters.join(" AND "),
    ExpressionAttributeNames,
    ExpressionAttributeValues,
  };
}

/**
 * Repository for managing audit records in DynamoDB.
 *
 * Provides CRUD operations for audit records with support for:
 * - Single item retrieval by identifiers
 * - Batch upsert operations with automatic batching
 * - Paginated listing by resource
 * - Paginated listing by trace ID for distributed tracing
 *
 * The repository uses a single-table design with composite keys and
 * multiple GSI/LSI indexes for efficient query patterns.
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
 * // Upsert multiple audit records
 * await repository.upsertBatch([
 *   { operation: 'createUser', status: 'success', ... },
 *   { operation: 'updateUser', status: 'success', ... },
 * ]);
 *
 * // List audits for a specific resource
 * const { items, pagination } = await repository.listItems({
 *   app: 'Orders',
 *   resource: { type: 'Order', id: 'user-123' },
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
          Key: marshall(this.constructPrimaryKey(identifiers), {
            removeUndefinedValues: true,
            convertEmptyValues: true,
            convertClassInstanceToMap: true,
          }),
        }),
      );

      return item ? this.transformItem(unmarshall(item) as DynamoDBItem) : undefined;
    } catch (error) {
      this.logger.error("Failed to read audit item", {
        identifiers,
        error,
      });

      throw error;
    }
  }

  /**
   * Upserts multiple audit records in batch.
   *
   * Performs a DynamoDB BatchWriteItem operation, automatically chunking
   * items into batches of 25 (DynamoDB's maximum batch size).
   * Each item is enriched with:
   * - Primary keys (PK, SK)
   * - Secondary index keys (GSI1_SS, GSI1_SN, LSI1_N)
   * - TTL attribute (90 days from creation)
   * - Timestamps (createdAt, updatedAt)
   *
   * @param items - Array of audit records to upsert
   * @returns True when the operation completes (retries unprocessed items with exponential backoff; throws if max retries exceeded)
   *
   * @example
   * ```typescript
   * await repository.upsertBatch([
   *   {
   *     operation: 'createUser',
   *     status: 'success',
   *     tier: 2,
   *     target: { app: App.App1, type: ResourceType.USER, id: 'user-123' },
   *   },
   *   {
   *     operation: 'updateUser',
   *     status: 'success',
   *     tier: 2,
   *     target: { app: App.App1, type: ResourceType.USER, id: 'user-456' },
   *   },
   * ]);
   * ```
   */
  public async upsertBatch(items: Array<UpsertAuditInput>): Promise<boolean> {
    const BATCH_SIZE = 25;

    const updatedAt = new Date();

    const Items: WriteRequest[] = await Promise.all(
      items.map((item): WriteRequest => {
        const payload = AuditStorageSchema.parse({
          createdAt: updatedAt,
          ...item,
          updatedAt: updatedAt,
        });

        return {
          PutRequest: {
            Item: marshall(
              {
                ...this.constructPrimaryKey({
                  tenantId: payload.tenantId,
                  id: payload.id,
                  resourceType: payload.target.type,
                  app: payload.target.app,
                }),
                ...this.constructSecondaryKeys(payload),
                ...this.constructTTLAttribute(this.config.ttlSeconds),
                ...payload,
              },
              {
                removeUndefinedValues: true,
                convertEmptyValues: true,
                convertClassInstanceToMap: true,
              },
            ),
          },
        };
      }),
    );

    const ItemBatches: WriteRequest[][] = [];

    // Chunk into batches of 25 (DynamoDB BatchWriteItem limit)
    for (let i = 0, j = Items.length; i < j; i += BATCH_SIZE) {
      ItemBatches.push(Items.slice(i, i + BATCH_SIZE));
    }

    // Process batches sequentially to reduce risk of triggering additional throttling
    for (const ItemBatch of ItemBatches) {
      await this.writeBatchWithRetry(ItemBatch, DynamoDB.Table.Name());
    }

    return true;
  }

  /**
   * Writes a batch of items to DynamoDB with exponential backoff retry for unprocessed items.
   *
   * DynamoDB's BatchWriteItem can return unprocessed items when throttled or under transient
   * errors without throwing an exception. This method retries those items automatically.
   *
   * @param items - Array of WriteRequests to send
   * @param tableName - Target DynamoDB table name
   * @param maxRetries - Maximum number of retry attempts (default: 8)
   * @param baseDelayMs - Initial delay in milliseconds before first retry (default: 100)
   * @throws Error if unprocessed items remain after maxRetries attempts
   * @internal
   */
  private async writeBatchWithRetry(
    items: WriteRequest[],
    tableName: string,
    maxRetries = 8,
    baseDelayMs = 100,
  ): Promise<void> {
    let requestItems: Record<string, WriteRequest[]> = { [tableName]: items };
    let attempt = 0;
    let delayMs = baseDelayMs;

    while (attempt <= maxRetries) {
      const response = await this.client.send(
        new BatchWriteItemCommand({ RequestItems: requestItems }),
      );

      const unprocessed = response.UnprocessedItems;
      if (!unprocessed || Object.keys(unprocessed).length === 0) {
        return; // all items written successfully
      }

      attempt++;
      if (attempt > maxRetries) {
        this.logger.error("BatchWriteItem: unprocessed items remain after max retries", {
          unprocessed,
          attempt,
        });
        throw new Error(`BatchWriteItem failed: unprocessed items after ${maxRetries} retries`);
      }

      this.logger.warn("BatchWriteItem: retrying unprocessed items", {
        count: Object.values(unprocessed).flat().length,
        attempt,
        delayMs,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000); // cap at 30 seconds
      requestItems = unprocessed as Record<string, WriteRequest[]>;
    }
  }

  /**
   * Reads items by primary key in batches, with exponential backoff retry for unprocessed keys.
   *
   * Keys are chunked into batches of 100 (DynamoDB's BatchGetItem limit). Items that
   * don't exist are absent from the result.
   *
   * @param keys - Primary keys of the items to read
   * @param attributes - Attributes to project
   * @param maxRetries - Maximum number of retry attempts per batch (default: 8)
   * @param baseDelayMs - Initial delay in milliseconds before first retry (default: 100)
   * @returns The items found, unmarshalled
   * @throws Error if unprocessed keys remain after maxRetries attempts
   * @internal
   */
  private async getBatchWithRetry(
    keys: DynamoDBPrimaryKey[],
    attributes: ReadonlyArray<string>,
    maxRetries = 8,
    baseDelayMs = 100,
  ): Promise<UnmarshalledAttributes[]> {
    const BATCH_SIZE = 100;
    const tableName = DynamoDB.Table.Name();

    const ExpressionAttributeNames = Object.fromEntries(
      attributes.map((attribute, i) => [`#a${i}`, attribute]),
    );
    const ProjectionExpression = Object.keys(ExpressionAttributeNames).join(", ");

    const items: UnmarshalledAttributes[] = [];

    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      let requestKeys = keys.slice(i, i + BATCH_SIZE).map((key) => marshall(key));
      let attempt = 0;
      let delayMs = baseDelayMs;

      while (requestKeys.length > 0) {
        const response = await this.client.send(
          new BatchGetItemCommand({
            RequestItems: {
              [tableName]: { Keys: requestKeys, ProjectionExpression, ExpressionAttributeNames },
            },
          }),
        );

        items.push(...(response.Responses?.[tableName] ?? []).map((item) => unmarshall(item)));

        requestKeys = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
        if (requestKeys.length === 0) {
          break;
        }

        attempt++;
        if (attempt > maxRetries) {
          this.logger.error("BatchGetItem: unprocessed keys remain after max retries", {
            unprocessed: requestKeys.length,
            attempt,
          });
          throw new Error(`BatchGetItem failed: unprocessed keys after ${maxRetries} retries`);
        }

        this.logger.warn("BatchGetItem: retrying unprocessed keys", {
          count: requestKeys.length,
          attempt,
          delayMs,
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30_000); // cap at 30 seconds
      }
    }

    return items;
  }

  /**
   * Replaces related-resource rows in a listing page with their parent audits.
   *
   * `AuditService.upsertItem` writes a copy of an audit per additional resource, with a
   * compound sort key (`{parentId}#{app}.{type}#{resourceId}`), the resource as `target`
   * and the parent's target as `source`. When a target filter matches such a copy, the
   * parent is listed in its place. Parents not already on the page are read from the
   * table, keyed by the copy's `source`, and kept only while they're still in the queried
   * index partition (a copy can be stale, e.g. after the audit moves to another status).
   * Each parent is listed once, at the position of its first matching row.
   *
   * Deduplication is per page: when an audit's rows match on different pages, the audit is
   * listed on each of them.
   *
   * @param items - Listing page, in index order
   * @param partition - Index partition key attribute and the value queried, plus the
   *   index keys to read for fetched parents
   * @param tenantId - Tenant the query was made with, if any
   * @returns The page with related-resource rows mapped to their parents
   * @internal
   */
  private async resolveRelatedItems<
    T extends Pick<DynamoDBPrimaryKey, "PK" | "SK"> & Pick<ListingAttributes, "source">,
  >(
    items: T[],
    partition: { key: string; value: string; attributes: ReadonlyArray<string> },
    tenantId?: string,
  ): Promise<T[]> {
    const parentId = (item: T) => item.SK.split("#")[0];
    const isRelated = (item: T) => item.SK.includes("#");

    if (!items.some(isRelated)) {
      return items;
    }

    const parents = new Map(items.filter((i) => !isRelated(i)).map((i) => [i.SK, i]));

    const keys = new Map<string, DynamoDBPrimaryKey>();
    for (const item of items) {
      const id = parentId(item);
      if (!isRelated(item) || !item.source || parents.has(id) || keys.has(id)) continue;

      keys.set(
        id,
        this.constructPrimaryKey({
          tenantId,
          id,
          app: item.source.app,
          resourceType: item.source.type,
        }),
      );
    }

    const fetched = await this.getBatchWithRetry(
      [...keys.values()],
      [
        DynamoDB.Keys.PARTITION_KEY,
        DynamoDB.Keys.SORT_KEY,
        ...partition.attributes,
        ...LISTING_INDEX_ATTRIBUTES,
      ],
    );
    for (const parent of fetched) {
      if (parent[partition.key] === partition.value) {
        parents.set(parent[DynamoDB.Keys.SORT_KEY], parent as T);
      }
    }

    const listed = new Set<string>();
    return items.flatMap((item) => {
      const id = parentId(item);
      const parent = parents.get(id);
      if (!parent) {
        this.logger.debug("Skipping related audit without a listable parent", { SK: item.SK });
        return [];
      }
      if (listed.has(id)) return [];

      listed.add(id);
      return [parent];
    });
  }

  /**
   * Upserts a single audit record with atomic attempt tracking.
   *
   * Uses DynamoDB UpdateItem with conditional expressions to:
   * - Create a new item if it doesn't exist (with attempts = [currentAttempt])
   * - Append to existing attempts array if item exists
   * - Preserve original createdAt timestamp on updates
   *
   * This is atomic and race-condition safe for retry tracking.
   *
   * Attempts are system-managed: each call appends exactly one attempt (`currentAttempt`).
   * Any `attempts` on `item` are ignored; they are neither written nor appended.
   *
   * @param item - The audit record to upsert (its `attempts`, if any, are ignored)
   * @param currentAttempt - The current attempt to append
   * @returns The attempt number (1 for new items, incremented for existing)
   *
   * @example
   * ```typescript
   * const attemptNumber = await repository.upsertItem(
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
  ): Promise<number> {
    const now = new Date();

    const payload = AuditStorageSchema.parse({
      createdAt: now,
      ...item,
      updatedAt: now,
    });

    const primaryKey = this.constructPrimaryKey({
      tenantId: payload.tenantId,
      id: payload.id,
      resourceType: payload.target.type,
      app: payload.target.app,
    });

    const secondaryKeys = this.constructSecondaryKeys(payload);
    const ttlAttribute = this.constructTTLAttribute(this.config.ttlSeconds);

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

    // Add all payload fields dynamically
    const allFields: Record<string, unknown> = {
      ...payload,
      ...secondaryKeys,
      ttl: ttlAttribute.ttl,
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
        Key: marshall(primaryKey, {
          removeUndefinedValues: true,
          convertEmptyValues: true,
          convertClassInstanceToMap: true,
        }),
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues, {
          removeUndefinedValues: true,
          convertEmptyValues: true,
          convertClassInstanceToMap: true,
        }),
        ReturnValues: "ALL_NEW",
      }),
    );

    if (!result.Attributes) {
      throw new Error("UpdateItem did not return attributes");
    }
    const updated = unmarshall(result.Attributes) as { attempts: unknown[] };
    const attemptNumber = updated.attempts.length;

    if (attemptNumber !== currentAttempt.number) {
      await this.client.send(
        new UpdateItemCommand({
          TableName: DynamoDB.Table.Name(),
          Key: marshall(primaryKey, {
            removeUndefinedValues: true,
            convertEmptyValues: true,
            convertClassInstanceToMap: true,
          }),
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

    return attemptNumber;
  }

  public async listObjects(params: TypedListObjectsOptions<C>, pagination?: Pagination) {
    const startKey = decodeNextPageToken(pagination?.nextToken);

    const pageSize = Number(pagination?.pageSize || 100);

    const pkBase = `${params.app}.${params.resource.type}`;
    const pk = params.tenantId ? `${params.tenantId}#${pkBase}` : pkBase;

    const { Items: items, LastEvaluatedKey: lastEvaluatedKey } = await this.client.send(
      new QueryCommand({
        ScanIndexForward: false,
        IndexName: DynamoDB.Indexes.LSI1_N,
        ExpressionAttributeValues: marshall({
          ":PK": pk,
        }),
        ExpressionAttributeNames: {
          "#PK": DynamoDB.Keys.PARTITION_KEY,
        },
        KeyConditionExpression: "#PK=:PK",
        TableName: DynamoDB.Table.Name(),
        Limit: pageSize,
        ExclusiveStartKey: startKey
          ? marshall(startKey, {
              removeUndefinedValues: true,
              convertEmptyValues: true,
              convertClassInstanceToMap: true,
            })
          : undefined,
      }),
    );

    return PaginationCollectionSchema(AuditPayloadSchema).parse({
      items: items?.map((i) =>
        this.transformListItem(unmarshall(i) as ListingItem, params.tenantId),
      ),
      pagination: {
        nextToken: lastEvaluatedKey ? encodeNextPageToken(unmarshall(lastEvaluatedKey)) : undefined,
      },
    });
  }

  /**
   * Lists audit records for a specific resource with pagination.
   *
   * Queries the GSI1_SS index to efficiently retrieve all audits
   * associated with a specific app/resource combination.
   * Results are returned in reverse chronological order.
   *
   * @param params - Query parameters including app and resource identifiers
   * @param pagination - Optional pagination settings (pageSize, nextToken)
   * @returns Paginated collection of audit records
   *
   * @example
   * ```typescript
   * // Get first page
   * const page1 = await repository.listItems({
   *   app: 'Orders',
   *   resource: { type: 'Order', id: 'user-123' },
   * });
   *
   * // Get next page using the pagination token
   * const page2 = await repository.listItems(
   *   { app: 'Orders', resource: { type: 'Order', id: 'user-123' } },
   *   { nextToken: page1.pagination?.nextToken },
   * );
   * ```
   */
  public async listItems(params: TypedListItemsOptions<C>, pagination?: Pagination) {
    const startKey = decodeNextPageToken(pagination?.nextToken);

    const pageSize = Number(pagination?.pageSize || 100);

    const pkBase = `${params.app}.${params.resource.type}#${params.resource.id}`;
    const pk = params.tenantId ? `${params.tenantId}#${pkBase}` : pkBase;

    const { Items: items, LastEvaluatedKey: lastEvaluatedKey } = await this.client.send(
      new QueryCommand({
        ScanIndexForward: false,
        IndexName: DynamoDB.Indexes.GSI1_SS,
        ExpressionAttributeValues: marshall({
          ":PK": pk,
        }),
        ExpressionAttributeNames: {
          "#PK": DynamoDB.Keys.GSI1_SS_PARTITION_KEY,
        },
        KeyConditionExpression: "#PK=:PK",
        TableName: DynamoDB.Table.Name(),
        Limit: pageSize,
        ExclusiveStartKey: startKey
          ? marshall(startKey, {
              removeUndefinedValues: true,
              convertEmptyValues: true,
              convertClassInstanceToMap: true,
            })
          : undefined,
      }),
    );

    return PaginationCollectionSchema(AuditPayloadSchema).parse({
      items: items?.map((i) =>
        this.transformListItem(unmarshall(i) as ListingItem, params.tenantId),
      ),
      pagination: {
        nextToken: lastEvaluatedKey ? encodeNextPageToken(unmarshall(lastEvaluatedKey)) : undefined,
      },
    });
  }

  /**
   * Lists audit records by trace ID for distributed tracing.
   *
   * Queries the GSI1_SN index to retrieve all audits sharing
   * the same trace ID, ordered by trace stage/depth.
   * Supports optional filtering by app, resource type, and resource ID.
   * A filter matches an audit's target or any of its additional resources;
   * each matching audit is listed once per page.
   *
   * This is useful for viewing the complete audit trail of a
   * distributed operation across multiple services or resources.
   *
   * @param params - Query parameters including trace ID and optional filters
   * @param pagination - Optional pagination settings (pageSize, nextToken)
   * @returns Paginated collection of audit records in trace order
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
    const startKey = decodeNextPageToken(pagination?.nextToken);

    const pageSize = Number(pagination?.pageSize || 100);

    const pkBase = params.trace;
    const pk = params.tenantId ? `${params.tenantId}#${pkBase}` : pkBase;

    const filter = buildTargetFilter(params);

    const { Items: items, LastEvaluatedKey: lastEvaluatedKey } = await this.client.send(
      new QueryCommand({
        ScanIndexForward: true,
        IndexName: DynamoDB.Indexes.GSI1_SN,
        ExpressionAttributeValues: marshall({
          ":PK": pk,
          ...filter.ExpressionAttributeValues,
        }),
        ExpressionAttributeNames: {
          "#PK": DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
          ...filter.ExpressionAttributeNames,
        },
        KeyConditionExpression: "#PK=:PK",
        TableName: DynamoDB.Table.Name(),
        Limit: pageSize,
        ExclusiveStartKey: startKey ? marshall(startKey) : undefined,
        FilterExpression: filter.FilterExpression,
      }),
    );

    const resolved = await this.resolveRelatedItems(
      (items ?? []).map((i) => unmarshall(i) as TraceListingItem),
      {
        key: DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
        value: pk,
        attributes: [DynamoDB.Keys.GSI1_SN_PARTITION_KEY, DynamoDB.Keys.GSI1_SN_SORT_KEY],
      },
      params.tenantId,
    );

    return PaginationCollectionSchema(AuditPayloadSchema).parse({
      items: resolved.map((i) => this.transformTraceListItem(i, params.tenantId)),
      pagination: {
        nextToken: lastEvaluatedKey ? encodeNextPageToken(unmarshall(lastEvaluatedKey)) : undefined,
      },
    });
  }

  /**
   * Lists audit records by status with date ordering and optional filters.
   *
   * Queries the GSI2_SS index to retrieve all audits with a specific status,
   * ordered by creation date (most recent first by default).
   * Supports optional filtering by app, resource type, and resource ID.
   * A filter matches an audit's target or any of its additional resources;
   * each matching audit is listed once per page.
   *
   * Items don't include `trace`: GSI2_SS projects neither the trace nor the
   * trace keys. Fetch the audit with {@link getItem} when the trace is needed.
   *
   * @param params - Query parameters including status and optional filters
   * @param pagination - Optional pagination settings (pageSize, nextToken)
   * @returns Paginated collection of audit records in reverse date order
   */
  public async listByStatus(params: TypedListByStatusOptions<C>, pagination?: Pagination) {
    const startKey = decodeNextPageToken(pagination?.nextToken);

    const pageSize = Number(pagination?.pageSize || 100);

    const pkBase = params.status;
    const pk = params.tenantId ? `${params.tenantId}#${pkBase}` : pkBase;

    const filter = buildTargetFilter(params);

    const { Items: items, LastEvaluatedKey: lastEvaluatedKey } = await this.client.send(
      new QueryCommand({
        ScanIndexForward: false,
        IndexName: DynamoDB.Indexes.GSI2_SS,
        ExpressionAttributeValues: marshall({
          ":PK": pk,
          ...filter.ExpressionAttributeValues,
        }),
        ExpressionAttributeNames: {
          "#PK": DynamoDB.Keys.GSI2_SS_PARTITION_KEY,
          ...filter.ExpressionAttributeNames,
        },
        KeyConditionExpression: "#PK = :PK",
        TableName: DynamoDB.Table.Name(),
        Limit: pageSize,
        ExclusiveStartKey: startKey ? marshall(startKey) : undefined,
        FilterExpression: filter.FilterExpression,
      }),
    );

    const resolved = await this.resolveRelatedItems(
      (items ?? []).map((i) => unmarshall(i) as StatusListingItem),
      {
        key: DynamoDB.Keys.GSI2_SS_PARTITION_KEY,
        value: pk,
        attributes: [DynamoDB.Keys.GSI2_SS_PARTITION_KEY, DynamoDB.Keys.GSI2_SS_SORT_KEY],
      },
      params.tenantId,
    );

    return PaginationCollectionSchema(AuditPayloadSchema).parse({
      items: resolved.map((i) => this.transformStatusListItem(i)),
      pagination: {
        nextToken: lastEvaluatedKey ? encodeNextPageToken(unmarshall(lastEvaluatedKey)) : undefined,
      },
    });
  }

  /**
   * Constructs the DynamoDB primary key from identifiers.
   *
   * When tenantId is provided, it prefixes the partition key for multi-tenant isolation.
   *
   * @param identifiers - Object containing tenantId (optional), app, id, and resourceType
   * @returns Primary key object with PK and SK attributes
   * @internal
   */
  private constructPrimaryKey({
    tenantId,
    app,
    id,
    resourceType,
  }: Omit<Identifiers, "resourceId">): DynamoDBPrimaryKey {
    const pkBase = `${app}.${resourceType}`;
    return {
      [DynamoDB.Keys.PARTITION_KEY]: (tenantId ? `${tenantId}#${pkBase}` : pkBase) as PK,
      [DynamoDB.Keys.SORT_KEY]: `${id}`,
    };
  }

  /**
   * Constructs all secondary index keys for an audit item.
   *
   * Includes:
   * - LSI1_N: Tier-based sort key for priority ordering
   * - GSI1_SS: Resource-based index keys
   * - GSI1_SN: Trace-based index keys (if trace exists)
   *
   * @param item - The audit storage item
   * @returns Object containing all secondary key attributes
   * @internal
   */
  private constructSecondaryKeys(item: AuditStorage): SecondaryKeys {
    return {
      [DynamoDB.Keys.LSI1_N_SORT_KEY]: Number(`${item.tier}${Date.now()}`),
      ...this.constructGSI1_SS({
        tenantId: item.tenantId,
        id: item.id,
        resourceType: item.target.type,
        resourceId: item.target.id,
        app: item.target.app,
      }),
      ...this.constructGSI1_SN(item),
      ...this.constructGSI2_SS(item),
    };
  }

  /**
   * Constructs GSI1_SS (String-String) index keys for resource-based queries.
   *
   * The partition key combines app, resourceType, and resourceId for
   * efficient querying of all audits for a specific resource.
   * When tenantId is provided, it prefixes the partition key for multi-tenant isolation.
   *
   * @param identifiers - Full identifiers including resourceId and optional tenantId
   * @returns GSI1_SS key attributes
   * @internal
   */
  private constructGSI1_SS({
    tenantId,
    app,
    id,
    resourceType,
    resourceId,
  }: Identifiers): DynamoDBGSI1Keys {
    const pkBase = [`${app}.${resourceType}`, resourceId].filter(Boolean).join("#");
    return {
      [DynamoDB.Keys.GSI1_SS_PARTITION_KEY]: (tenantId
        ? `${tenantId}#${pkBase}`
        : pkBase) as GSI1PK,
      [DynamoDB.Keys.GSI1_SS_SORT_KEY]: String(id),
    };
  }

  /**
   * Constructs GSI1_SN (String-Number) index keys for trace-based queries.
   *
   * Parses the trace string to extract the trace ID and stage number,
   * enabling efficient querying of all audits in a distributed trace.
   * When tenantId is provided, it prefixes the partition key for multi-tenant isolation.
   *
   * @param item - The audit storage item
   * @returns GSI1_SN key attributes, or empty object if no trace
   * @internal
   */
  private constructGSI1_SN(item: AuditStorage): DynamoDBTraceGSIKeys {
    if (!item.trace) {
      return {};
    }

    const { id, stage } = getTraceParts(item.trace);
    const pkBase = `${id}`;

    return {
      [DynamoDB.Keys.GSI1_SN_PARTITION_KEY]: (item.tenantId
        ? `${item.tenantId}#${pkBase}`
        : pkBase) as TraceGSIPK,
      [DynamoDB.Keys.GSI1_SN_SORT_KEY]: stage,
    };
  }

  /**
   * Constructs GSI2_SS (String-String) index keys for status-based queries.
   *
   * The partition key is the status value (optionally prefixed with tenantId),
   * and the sort key combines createdAt timestamp with id for date ordering
   * while ensuring uniqueness.
   *
   * @param item - The audit storage item
   * @returns GSI2_SS key attributes
   * @internal
   */
  private constructGSI2_SS(item: AuditStorage): DynamoDBGSI2Keys {
    const pkBase = item.status;

    return {
      [DynamoDB.Keys.GSI2_SS_PARTITION_KEY]: (item.tenantId
        ? `${item.tenantId}#${pkBase}`
        : pkBase) as GSI2PK,
      [DynamoDB.Keys.GSI2_SS_SORT_KEY]: `${item.createdAt}#${item.id}`,
    };
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
    const ttl = date || new Date();

    if (ttlSeconds) {
      ttl.setSeconds(ttl.getSeconds() + ttlSeconds);
    }

    return {
      ttl: Math.floor(ttl.valueOf() / 1000),
    };
  }

  /**
   * Replaces an item's stored `trace` with the one to return.
   *
   * 1. A stored string `trace` is returned verbatim.
   * 2. Otherwise, when both GSI1_SN keys are present, the trace is rebuilt from them:
   *    a leading `{tenantId}#` is stripped when the tenant is known (from the item, or the
   *    tenant the query was made with), and the stage is appended unless it's 0. A trace
   *    written as `abc:0` therefore comes back as `abc`, which is equivalent.
   *    When the tenant isn't known, the key is returned as-is rather than guessing a
   *    prefix by splitting on `#`.
   * 3. Otherwise the `trace` key is removed. This covers a trace stored as NULL
   *    (an empty string written with `convertEmptyValues`).
   *
   * @param item - Raw DynamoDB item, or the attributes an index projects
   * @param tenantId - Tenant the query was made with, if any
   * @returns The item, with `trace` only when resolvable
   * @internal
   */
  private resolveTrace<
    T extends { trace?: unknown; tenantId?: string } & Partial<
      Pick<SecondaryKeys, "GSI1_SN_PK" | "GSI1_SN_SK">
    >,
  >(item: T, tenantId?: string): Omit<T, "trace"> & { trace?: string } {
    const { trace, ...rest } = item;

    if (typeof trace === "string") {
      return { ...rest, trace };
    }

    if (item.GSI1_SN_PK === undefined || item.GSI1_SN_SK === undefined) {
      return rest;
    }

    const tenant = item.tenantId ?? tenantId;
    const prefix = tenant ? `${tenant}#` : undefined;
    const id =
      prefix && item.GSI1_SN_PK.startsWith(prefix)
        ? item.GSI1_SN_PK.slice(prefix.length)
        : item.GSI1_SN_PK;
    const stage = Number(item.GSI1_SN_SK);

    return { ...rest, trace: stage === 0 ? id : `${id}:${stage}` };
  }

  /**
   * Transforms a raw DynamoDB item into an Audit object.
   *
   * Resolves the trace string and extracts the clean ID
   * from compound keys.
   *
   * @param item - Raw DynamoDB item with all keys
   * @returns Parsed and validated Audit object
   * @internal
   */
  private transformItem(item: DynamoDBItem): Audit {
    return AuditSchema.parse({
      ...this.resolveTrace(item),
      id: item.id.split("#").pop(),
    });
  }

  /**
   * Transforms a trace listing item into an audit list item payload.
   *
   * @param item - Raw trace listing item from GSI1_SN query
   * @param tenantId - Tenant the query was made with, if any
   * @returns Parsed audit list item payload
   * @internal
   */
  private transformTraceListItem(item: TraceListingItem, tenantId?: string) {
    const [id] = item.SK.split("#");

    return AuditPayloadSchema.parse({
      ...this.resolveTrace(item, tenantId),
      id: id,
    });
  }

  /**
   * Transforms a resource listing item into an audit list item payload.
   *
   * @param item - Raw listing item from LSI1_N or GSI1_SS query
   * @param tenantId - Tenant the query was made with, if any
   * @returns Parsed audit list item payload
   * @internal
   */
  private transformListItem(item: ListingItem, tenantId?: string) {
    const [id] = item.SK.split("#");

    return AuditPayloadSchema.parse({
      ...this.resolveTrace(item, tenantId),
      id: id,
    });
  }

  /**
   * Transforms a status listing item into an audit list item payload.
   *
   * GSI2_SS projects neither `trace` nor the GSI1_SN keys, so `trace` is
   * absent from status listings.
   *
   * @param item - Raw listing item from GSI2_SS query
   * @returns Parsed audit list item payload
   * @internal
   */
  private transformStatusListItem(item: StatusListingItem) {
    const [id] = item.SK.split("#");

    return AuditPayloadSchema.parse({
      ...item,
      id: id,
    });
  }
}
