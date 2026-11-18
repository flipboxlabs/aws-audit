import type { Logger } from "@aws-lambda-powertools/logger";
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { NativeAttributeValue } from "@aws-sdk/util-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { DEFAULT_TTL_SECONDS, type AuditConfig } from "./config.js";
import { DynamoDB, type IndexDefinition } from "./constants.js";
import {
  InvalidNextTokenError,
  InvalidResourceFilterError,
  ReservedTenantError,
} from "./errors.js";
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
import { getTraceParts, hasResourceId } from "./utils.js";

const { Attributes, Indexes, Keys } = DynamoDB;

/**
 * An empty string is written as one, not as NULL (`convertEmptyValues`): the
 * schemas don't accept a null in its place, so an item wouldn't read back as written.
 */
const MARSHALL_OPTIONS = {
  removeUndefinedValues: true,
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
  kind?: typeof DynamoDB.Kinds.AUDIT;
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
 * Each app of the config with one of its resource types, as `{ app, resourceType }`.
 * @typeParam C - The audit config type for type inference
 */
type TypedAppResourceType<C extends AuditConfig> = {
  [A in InferApp<C>]: {
    /** Application that owns this audit record */
    app: A;
    /** Type of resource being audited, one of the app's */
    resourceType: InferResourceType<C, A>;
  };
}[InferApp<C>];

/**
 * An audit's key, with typed App and ResourceType from config: naming the app
 * narrows the resource type to that app's. (`Omit` on {@link TypedIdentifiers}
 * would lose that, as it doesn't distribute over each app.)
 * @typeParam C - The audit config type for type inference
 */
export type TypedAuditIdentifiers<C extends AuditConfig> = TypedAppResourceType<C> & {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
  /** Unique audit record identifier */
  id: string | number;
};

/**
 * Generic identifiers with typed App and ResourceType from config: naming the app
 * narrows the resource type to that app's.
 * @typeParam C - The audit config type for type inference
 */
export type TypedIdentifiers<C extends AuditConfig> = TypedAuditIdentifiers<C> & {
  /** Optional resource identifier within the application */
  resourceId?: string | number;
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
 * the audit's target or any of its related resources. With an app, the type is one
 * of that app's; without one, a type matches it under every app. A resource id is
 * matched only together with its app and type.
 * @typeParam C - The audit config type for type inference
 */
export type TypedResourceFilters<C extends AuditConfig> =
  | {
      /** No application filter */
      app?: undefined;
      /** Optional resource filter */
      resource?: {
        /** Filter by resource type, under any app that has it */
        type?: InferResourceType<C>;
        /** Filter by resource ID; needs `app` and `resource.type` */
        id?: string | number;
      };
    }
  | {
      [A in InferApp<C>]: {
        /** Application filter */
        app: A;
        /** Optional resource filter */
        resource?: {
          /** Filter by resource type, one of the app's */
          type?: InferResourceType<C, A>;
          /** Filter by resource ID; needs `app` and `resource.type` */
          id?: string | number;
        };
      };
    }[InferApp<C>];

/**
 * Options for listing audit objects by resource with typed App and ResourceType:
 * naming the app narrows the resource type to that app's.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListObjectsOptions<C extends AuditConfig> = ListFilters & {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
} & {
    [A in InferApp<C>]: {
      /** Application owning the resource */
      app: A;
      /** Resource identification */
      resource: {
        /** Type of the resource, one of the app's */
        type: InferResourceType<C, A>;
      };
    };
  }[InferApp<C>];

/**
 * Options for listing audit items by resource with typed App and ResourceType:
 * naming the app narrows the resource type to that app's.
 * @typeParam C - The audit config type for type inference
 */
export type TypedListItemsOptions<C extends AuditConfig> = ListFilters & {
  /** Tenant/organization identifier for multi-tenancy support (optional) */
  tenantId?: string;
} & {
    [A in InferApp<C>]: {
      /** Application owning the resource */
      app: A;
      /** Resource identification */
      resource: {
        /** Type of the resource, one of the app's */
        type: InferResourceType<C, A>;
        /** Unique identifier of the resource */
        id: string | number;
      };
    };
  }[InferApp<C>];

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
 * Joins the parts of a key or `scopes` value with `#`, escaping `%`, `#` and `*` in
 * each (as `%25`, `%23` and `%2A`), so distinct parts never join to the same value:
 * a tenant and an audit id holding a `#` would otherwise share a partition with
 * another tenant's audit.
 *
 * @example
 * ```typescript
 * joinKey("tenant-1", "App1", "Order", "a#1"); // "tenant-1#App1#Order#a%231"
 * ```
 * @internal
 */
export function joinKey(...parts: (string | number)[]): string {
  return parts
    .map((part) =>
      String(part).replace(/[%#*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("#");
}

/**
 * What an audit's `scopes` attribute holds for one of its resources: everything a
 * resource filter can name it by (`{app}`, `{app}#{type}`, `*#{type}` and
 * `{app}#{type}#{id}`, each part escaped by {@link joinKey}).
 *
 * @internal
 */
export function resourceScopes(resource: ResourceReference): string[] {
  const scopes = [
    joinKey(resource.app),
    joinKey(resource.app, resource.type),
    `*#${joinKey(resource.type)}`,
  ];
  if (hasResourceId(resource.id)) {
    scopes.push(joinKey(resource.app, resource.type, resource.id));
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
    return joinKey(app, resource.type, resource.id);
  }

  if (app && resource?.type) return joinKey(app, resource.type);
  if (app) return joinKey(app);
  if (resource?.type) return `*#${joinKey(resource.type)}`;
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

/**
 * The tenant part of every index key.
 *
 * @throws {ReservedTenantError} For the tenant id `-`, the key of audits without a
 *   tenant, which a listing would otherwise return as that tenant's
 */
function tenantKey(tenantId?: string): string {
  if (tenantId === DynamoDB.NO_TENANT) {
    throw new ReservedTenantError();
  }
  return tenantId || DynamoDB.NO_TENANT;
}

/**
 * Constructs the DynamoDB primary key of an audit: `PK`
 * `{tenantKey}#{app}#{type}#{id}`, each part escaped by {@link joinKey}, with `-`
 * as the tenant of an audit without one.
 *
 * @param identifiers - Object containing tenantId (optional), app, id, and resourceType
 * @returns Primary key object with PK and SK attributes
 * @throws {ReservedTenantError} For the tenant id `-`, which would read an audit
 *   without a tenant
 * @internal
 */
export function constructPrimaryKey({
  tenantId,
  app,
  id,
  resourceType,
}: Omit<Identifiers, "resourceId">): DynamoDBPrimaryKey {
  return {
    [Keys.PARTITION_KEY]: joinKey(tenantKey(tenantId), app, resourceType, id),
    [Keys.SORT_KEY]: DynamoDB.SortKeys.AUDIT,
  };
}

/**
 * The sort key of an audit's copy under a related resource:
 * `related#{app}#{type}#{id}`, each part escaped by {@link joinKey}.
 *
 * @internal
 */
export function relatedSortKey(resource: ResourceReference): string {
  return `${DynamoDB.SortKeys.RELATED_PREFIX}${joinKey(resource.app, resource.type, resource.id ?? "")}`;
}

/**
 * DynamoDB's largest partition and sort key attribute values, in bytes.
 *
 * @internal
 */
export const KEY_BYTES = { partition: 2048, sort: 1024 } as const;

/**
 * Whether a copy keyed `sortKey` ({@link relatedSortKey}) can be stored: a
 * resource id may be longer than a sort key allows.
 */
const fitsSortKey = (sortKey: string) => Buffer.byteLength(sortKey) <= KEY_BYTES.sort;

/**
 * Constructs the top-level attributes the index keys are built from.
 *
 * The resource id is stored as a string, so numeric and string ids list together.
 * Only audits get `kind` and the trace attributes, which keeps copies out of
 * `ByStatus` and `ByTrace`; an audit whose trace has no id (`:2`) gets no trace
 * attributes either.
 *
 * @param item - The audit, or a related-resource copy
 * @param kind - Whether the item is the audit or a copy
 * @returns The index attributes
 * @internal
 */
export function constructIndexAttributes(
  item: Pick<AuditStorage, "tenantId" | "target" | "trace">,
  kind: (typeof DynamoDB.Kinds)[keyof typeof DynamoDB.Kinds],
): IndexAttributes {
  const audit = kind === DynamoDB.Kinds.AUDIT;
  const trace = audit && item.trace ? getTraceParts(item.trace) : undefined;

  return {
    tenantKey: tenantKey(item.tenantId),
    app: item.target.app,
    resourceType: item.target.type,
    // A numeric id of 0 is an id; only a missing or empty one is left out
    ...(hasResourceId(item.target.id) ? { resourceId: String(item.target.id) } : {}),
    ...(audit ? { kind: DynamoDB.Kinds.AUDIT } : {}),
    // A trace without an id (`:2`) lists under none, as an index key can't be empty
    ...(trace?.id ? { traceId: trace.id, traceStage: trace.stage } : {}),
  };
}

/**
 * The copy of an audit, as stored, that lists it under a related resource: the
 * audit's summary, with the resource as `target`, the audit's target as `source`
 * and `related: true`, in the audit's partition (`SK`
 * `related#{app}#{type}#{resourceId}`), as `revision`, the audit's attempt count.
 *
 * @param audit - The audit as stored
 * @param resource - The related resource, with an id
 * @param options - The copy's `revision` and `ttl`
 * @returns The copy's attributes
 * @internal
 */
export function relatedCopy(
  audit: AuditStorage,
  resource: ResourceReference,
  { revision, ttl }: { revision: number; ttl?: number },
): UnmarshalledAttributes {
  const target = { app: resource.app, type: resource.type, id: resource.id };
  const copy = {
    ...AuditSummarySchema.parse(audit),
    target,
    source: audit.target,
    rerunable: audit.rerunable ?? !!audit.event,
    related: true,
  };
  const { PK } = constructPrimaryKey({
    tenantId: audit.tenantId,
    id: audit.id,
    resourceType: audit.target.type,
    app: audit.target.app,
  });

  return {
    [Keys.PARTITION_KEY]: PK,
    [Keys.SORT_KEY]: relatedSortKey(target),
    ...copy,
    ...constructIndexAttributes(copy, DynamoDB.Kinds.RELATED),
    ...(ttl === undefined ? {} : { [Attributes.TTL]: ttl }),
    [Attributes.REVISION]: revision,
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
 *   apps: { Orders: ['Order'], Inventory: ['Product'] },
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
   * @throws {ReservedTenantError} If the tenant id is `-`
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
  public async getItem(identifiers: TypedAuditIdentifiers<C>): Promise<Audit | undefined> {
    // The caller's mistake, so not logged
    const key = constructPrimaryKey(identifiers);
    try {
      const { Item: item } = await this.client.send(
        new GetItemCommand({
          TableName: DynamoDB.Table.Name(),
          Key: marshall(key, MARSHALL_OPTIONS),
        }),
      );

      return item ? AuditSchema.parse(withoutNulls(unmarshall(item))) : undefined;
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
   * A retry replaces the fields it gives and keeps those it leaves out, except the
   * target, which it replaces whole: a target without an id removes `resourceId`,
   * so the audit no longer lists under its earlier resource. Likewise a `trace`
   * without an id, empty or such as `:2`, removes `traceId` and `traceStage`, so
   * the audit leaves its earlier trace's listing. A retry that changes the
   * target's id removes the target it replaces from `scopes`, so the status and
   * trace filters no longer match it, unless the retry lists it as related or a
   * related resource's copy still lists the audit under it (see
   * {@link removePreviousTarget}).
   *
   * @param item - The audit record to upsert (its `attempts`, if any, are ignored)
   * @param currentAttempt - The current attempt to append
   * @returns The attempt number (1 for new items, incremented for existing), and
   *   the audit as stored, with the fields a retry kept and the stored `createdAt`
   *
   * @example
   * ```typescript
   * const { attemptNumber, audit } = await repository.upsertItem(
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
  ): Promise<{ attemptNumber: number; audit: AuditStorage }> {
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
      // Read before this write, so the target it replaces
      "#previousTarget = if_not_exists(#target, :target)",
    ];
    expressionAttributeNames["#attempts"] = "attempts";
    expressionAttributeNames["#createdAt"] = "createdAt";
    expressionAttributeNames["#previousTarget"] = Attributes.PREVIOUS_TARGET;

    // Added to, not replaced: a copy under a resource a retry no longer lists stays,
    // so the status and trace filters keep matching that resource too; the target
    // this replaces is removed below
    expressionAttributeNames["#scopes"] = Attributes.SCOPES;
    expressionAttributeValues[":scopes"] = new Set(
      [payload.target, ...(item.resources ?? [])].flatMap(resourceScopes),
    );

    // Add all payload fields dynamically
    const indexAttributes = constructIndexAttributes(payload, DynamoDB.Kinds.AUDIT);
    const allFields: Record<string, unknown> = {
      ...payload,
      ...indexAttributes,
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

    // The target is replaced whole, so its resourceId goes with it; a trace without
    // an id clears the trace's index attributes, so the audit leaves its listing
    const removed: string[] = [];
    if (!hasResourceId(payload.target.id)) {
      removed.push(Attributes.RESOURCE_ID);
    }
    if (payload.trace !== undefined && indexAttributes.traceId === undefined) {
      removed.push(Attributes.TRACE_ID, Attributes.TRACE_STAGE);
    }
    for (const name of removed) {
      expressionAttributeNames[`#${name}`] = name;
    }
    const removeClause = removed.length
      ? ` REMOVE ${removed.map((name) => `#${name}`).join(", ")}`
      : "";

    const result = await this.client.send(
      new UpdateItemCommand({
        TableName: DynamoDB.Table.Name(),
        Key: marshall(primaryKey, MARSHALL_OPTIONS),
        UpdateExpression: `SET ${setClauses.join(", ")} ADD #scopes :scopes${removeClause}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues, MARSHALL_OPTIONS),
        ReturnValues: "ALL_NEW",
      }),
    );

    if (!result.Attributes) {
      throw new Error("UpdateItem did not return attributes");
    }
    const updated = unmarshall(result.Attributes);
    const attemptNumber = (updated.attempts as unknown[]).length;

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

    if (attemptNumber > 1) {
      await this.removePreviousTarget(primaryKey, updated, item.resources ?? [], attemptNumber);
    }

    const audit = AuditStorageSchema.parse(withoutNulls(updated));
    // As renumbered above
    const appended = audit.attempts?.at(-1);
    if (appended) appended.number = attemptNumber;
    return { attemptNumber, audit };
  }

  /**
   * Removes from `scopes` the resource the audit targeted before a retry changed
   * its target's id (`previousTarget`, which the retry's write set): unless the
   * retry lists it as related, or a related resource's copy (read consistently)
   * lists the audit under it, and only when no upsert has appended an attempt
   * since `revision`, as a later one's target is its own. Only that resource's
   * scope goes: a related resource's scope stays even before an overlapping upsert
   * writes its copy. Nothing is read or written when the target is unchanged.
   *
   * @param key - The audit's key
   * @param stored - The audit as the retry stored it, with its `scopes` and
   *   `previousTarget`
   * @param listed - The retry's related resources
   * @param revision - The audit's attempt count, as the retry stored it
   */
  private async removePreviousTarget(
    key: DynamoDBPrimaryKey,
    stored: Record<string, unknown>,
    listed: Iterable<ResourceReference>,
    revision: number,
  ): Promise<void> {
    const previous = stored[Attributes.PREVIOUS_TARGET] as ResourceReference | undefined;
    if (!previous || !hasResourceId(previous.id)) return;

    const scope = joinKey(previous.app, previous.type, previous.id);
    const scopes = stored[Attributes.SCOPES] as Set<string> | undefined;
    const kept = new Set([stored.target as ResourceReference, ...listed].flatMap(resourceScopes));
    if (!scopes?.has(scope) || kept.has(scope)) return;

    // Unless a related resource's copy still lists the audit under it
    const sortKey = relatedSortKey(previous);
    if (fitsSortKey(sortKey)) {
      const { Item: copy } = await this.client.send(
        new GetItemCommand({
          TableName: DynamoDB.Table.Name(),
          Key: marshall({ ...key, [DynamoDB.Keys.SORT_KEY]: sortKey }, MARSHALL_OPTIONS),
          ProjectionExpression: "#pk",
          ExpressionAttributeNames: { "#pk": DynamoDB.Keys.PARTITION_KEY },
          ConsistentRead: true,
        }),
      );
      if (copy) return;
    }

    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: DynamoDB.Table.Name(),
          Key: marshall(key, MARSHALL_OPTIONS),
          UpdateExpression: "DELETE #scopes :scope",
          ConditionExpression: "size(#attempts) = :revision",
          ExpressionAttributeNames: { "#scopes": Attributes.SCOPES, "#attempts": "attempts" },
          ExpressionAttributeValues: marshall({
            ":scope": new Set([scope]),
            ":revision": revision,
          }),
        }),
      );
    } catch (error) {
      // An upsert since has its own target and scopes
      if ((error as Error | undefined)?.name !== "ConditionalCheckFailedException") throw error;
    }
  }

  /**
   * Writes the copy of an audit that lists it under each related resource with an id.
   *
   * A copy holds the audit's summary, with the resource as `target`, the audit's
   * target as `source` and `related: true`, in the audit's partition (`SK`
   * `related#{app}#{type}#{resourceId}`; see {@link relatedCopy}). It is built
   * from the audit as stored, so it holds the fields a retry kept and sorts with
   * the audit by its stored `createdAt`. Each upsert rewrites the copies of the
   * resources it lists, once per resource, except its own target, under which the
   * audit lists already; a copy under a resource a retry no longer lists stays,
   * as do that resource's `scopes` on the audit.
   *
   * Each copy is put in turn, as its `revision`, the audit's attempt count, and
   * only over a copy of the same or an earlier revision: when upserts of the audit
   * overlap, the copy is the latest one's, whichever writes its copies last.
   *
   * Then the audit is read again: when a migration (`aws-audit-migrate`) merged a
   * 1.x audit into it since it was upserted, its copies are put again from the
   * merged audit, at its revision. A merge rewrites the copies it finds, so a copy
   * written after it, from the audit before it, would stay otherwise.
   *
   * A retry whose target is a resource an earlier attempt listed deletes that
   * copy, as the audit lists under its target itself; so does an upsert that put
   * a copy under the target a later, overlapping upsert gave the audit. Each
   * delete leaves a copy a later upsert put.
   *
   * A resource whose copy's `SK` would be longer than DynamoDB allows (1,024 bytes)
   * gets no copy, with a warning, as the audit is stored already.
   *
   * @param audit - The audit as stored, from {@link upsertItem}
   * @param related - The resources the upsert listed in `resources`
   *
   * @example
   * ```typescript
   * const { audit } = await repository.upsertItem(item, attempt);
   * await repository.upsertRelated(audit, item.resources);
   * ```
   */
  public async upsertRelated(
    audit: AuditStorage,
    related: Iterable<ResourceReference> | undefined,
  ): Promise<void> {
    const key = constructPrimaryKey({
      tenantId: audit.tenantId,
      id: audit.id,
      resourceType: audit.target.type,
      app: audit.target.app,
    });
    const revision = audit.attempts?.length ?? 0;
    const own = hasResourceId(audit.target.id) ? relatedSortKey(audit.target) : undefined;

    // A retry's target may be a resource an earlier attempt listed: the audit lists
    // there itself now, so that copy goes, unless its key is too long for there to be one
    if (own && revision > 1 && fitsSortKey(own)) {
      await this.deleteRelated(key, own, revision);
    }

    // One copy per resource, from its last listing
    const resources = new Map<string, ResourceReference>();
    for (const resource of related ?? []) {
      if (!hasResourceId(resource.id)) continue;
      const sortKey = relatedSortKey(resource);
      if (fitsSortKey(sortKey)) {
        resources.set(sortKey, resource);
      } else {
        // The audit is stored already, so it isn't refused for one listing
        this.logger.warn("Related resource's id is too long for a copy to list it", {
          id: audit.id,
          resource,
          bytes: Buffer.byteLength(sortKey),
        });
      }
    }
    // The audit lists under its own target already
    if (own) resources.delete(own);
    if (resources.size === 0) return;

    await this.putRelated(audit, resources.values(), revision);

    const { Item: item } = await this.client.send(
      new GetItemCommand({
        TableName: DynamoDB.Table.Name(),
        Key: marshall(key, MARSHALL_OPTIONS),
        ConsistentRead: true,
      }),
    );
    if (!item) return;
    const current = unmarshall(item);
    const target = current.target as ResourceReference;
    const targetKey = hasResourceId(target.id) ? relatedSortKey(target) : undefined;

    const attempts = (current.attempts as unknown[] | undefined)?.length ?? 0;
    if (current[Attributes.MIGRATED] && attempts !== revision) {
      await this.putRelated(
        AuditStorageSchema.parse(withoutNulls(current)),
        Array.from(resources).flatMap(([sortKey, resource]) =>
          sortKey === targetKey ? [] : [resource],
        ),
        attempts,
      );
    }
    // An upsert since made one of these resources its target: the copy just put goes
    if (targetKey && targetKey !== own && resources.has(targetKey)) {
      await this.deleteRelated(key, targetKey, revision);
    }
  }

  /**
   * Deletes the copy under a resource the audit keyed `key` now targets, unless a
   * later upsert than `revision` put it.
   */
  private async deleteRelated(key: DynamoDBPrimaryKey, sortKey: string, revision: number) {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: DynamoDB.Table.Name(),
          Key: marshall({ ...key, [Keys.SORT_KEY]: sortKey }, MARSHALL_OPTIONS),
          ConditionExpression: "attribute_not_exists(#revision) OR #revision <= :revision",
          ExpressionAttributeNames: { "#revision": Attributes.REVISION },
          ExpressionAttributeValues: marshall({ ":revision": revision }),
        }),
      );
    } catch (error) {
      if ((error as Error | undefined)?.name !== "ConditionalCheckFailedException") throw error;
    }
  }

  /** Puts the copies of `audit` under `resources`, in turn, as `revision`. */
  private async putRelated(
    audit: AuditStorage,
    resources: Iterable<ResourceReference>,
    revision: number,
  ): Promise<void> {
    const { ttl } = this.constructTTLAttribute(this.config.ttlSeconds);

    // In turn, so a throttled table isn't hit harder
    for (const resource of resources) {
      try {
        await this.client.send(
          new PutItemCommand({
            TableName: DynamoDB.Table.Name(),
            Item: marshall(relatedCopy(audit, resource, { revision, ttl }), MARSHALL_OPTIONS),
            ConditionExpression: "attribute_not_exists(#revision) OR #revision <= :revision",
            ExpressionAttributeNames: { "#revision": Attributes.REVISION },
            ExpressionAttributeValues: marshall({ ":revision": revision }),
          }),
        );
      } catch (error) {
        // A later upsert of the audit wrote its copy already
        if ((error as Error | undefined)?.name !== "ConditionalCheckFailedException") throw error;
      }
    }
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
   * @throws {ReservedTenantError} if the tenant id is `-`
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
   * @throws {ReservedTenantError} if the tenant id is `-`
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
   * @throws {ReservedTenantError} if the tenant id is `-`
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
   * @throws {ReservedTenantError} if the tenant id is `-`
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
      items: (items ?? []).map((item) => withoutNulls(unmarshall(item))),
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
 * Drops the attributes stored as NULL: the 1.x SDK wrote an empty string as NULL
 * (`convertEmptyValues`), and a field such as `trace` doesn't accept it.
 *
 * @internal
 */
function withoutNulls(item: UnmarshalledAttributes): UnmarshalledAttributes {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null));
}
