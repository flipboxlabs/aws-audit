import type { Logger } from "@aws-lambda-powertools/logger";
import {
	BatchWriteItemCommand,
	DynamoDBClient,
	GetItemCommand,
	QueryCommand,
	type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type { NativeAttributeValue } from "@aws-sdk/util-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { AuditConfig } from "./config.js";
import { DynamoDB } from "./constants.js";
import {
	decodeNextPageToken,
	encodeNextPageToken,
} from "./repository.utils.js";
import {
	type Audit,
	AuditListItemPayloadSchema,
	AuditPayloadSchema,
	AuditSchema,
} from "./schema/audit.js";
import { type Pagination, PaginationCollectionSchema } from "./schema/model.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { type AuditStorage, AuditStorageSchema } from "./schema/storage.js";
import type {
	AnyApp,
	AnyResourceType,
	InferApp,
	InferResourceType,
} from "./types.js";
import { getTraceParts } from "./utils.js";

/**
 * Default TTL for audit records in seconds (90 days).
 * Records will be automatically deleted by DynamoDB after this period.
 */
const DEFAULT_TTL = 60 * 60 * 24 * 90; // 90 days

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

/**
 * DynamoDB GSI keys for resource-based listing queries.
 * Uses GSI1_SS (String-String) index for resource lookups.
 */
type DynamoDBGSI1Keys = {
	[DynamoDB.Keys.GSI1_SS_PARTITION_KEY]: GSI1PK;
	[DynamoDB.Keys.GSI1_SS_SORT_KEY]: GSI1SK;
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
	DynamoDBTraceGSIKeys & {
		[DynamoDB.Keys.LSI1_N_SORT_KEY]: number;
	};

/**
 * Complete DynamoDB item structure combining audit data with all keys.
 * Represents the full item as stored in DynamoDB.
 */
type DynamoDBItem = AuditStorage &
	TTLAttribute &
	DynamoDBPrimaryKey &
	SecondaryKeys;

/**
 * Subset of audit storage attributes used for listing operations.
 * Reduces data transfer by only including essential display fields.
 */
type ListingAttributes = Pick<
	AuditStorage,
	"operation" | "status" | "message" | "source" | "target" | "rerunable"
>;

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
type ListingItem = TraceListingItem &
	Pick<SecondaryKeys, "GSI1_SS_PK" | "GSI1_SS_SK">;

/**
 * Options for listing audit items by resource with typed App and ResourceType.
 * @typeParam C - The audit config type for type inference
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
	 * Returns undefined if the item is not found or if an error occurs.
	 *
	 * @param identifiers - Object containing id, app, and resourceType to locate the record
	 * @returns The audit record if found, undefined otherwise
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

			return item
				? this.transformItem(unmarshall(item) as DynamoDBItem)
				: undefined;
		} catch (error) {
			this.logger.error("Unable to find audit item in the repository", {
				identifiers,
				error,
			});

			return undefined;
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
	 * @returns True when the operation completes (does not check for unprocessed items)
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
								...this.constructTTLAttribute(DEFAULT_TTL),
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

		await Promise.all(
			ItemBatches.map((ItemBatch) =>
				this.client.send(
					new BatchWriteItemCommand({
						RequestItems: {
							[DynamoDB.Table.Name()]: ItemBatch,
						},
					}),
				),
			),
		);

		return true;
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
	public async listItems(
		params: TypedListItemsOptions<C>,
		pagination?: Pagination,
	) {
		const startKey = decodeNextPageToken(pagination?.nextToken);

		const pageSize = Number(pagination?.pageSize || 100);

		const pkBase = `${params.app}.${params.resource.type}#${params.resource.id}`;
		const pk = params.tenantId ? `${params.tenantId}#${pkBase}` : pkBase;

		const { Items: items, LastEvaluatedKey: lastEvaluatedKey } =
			await this.client.send(
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
				this.transformListItem(unmarshall(i) as ListingItem),
			),
			pagination: {
				nextToken: lastEvaluatedKey
					? encodeNextPageToken(unmarshall(lastEvaluatedKey))
					: undefined,
			},
		});
	}

	/**
	 * Lists audit records by trace ID for distributed tracing.
	 *
	 * Queries the GSI1_SN index to retrieve all audits sharing
	 * the same trace ID, ordered by trace stage/depth.
	 * Supports optional filtering by app, resource type, and resource ID.
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
	public async listTraceItems(
		params: TypedListTraceItems<C>,
		pagination?: Pagination,
	) {
		const startKey = decodeNextPageToken(pagination?.nextToken);

		const pageSize = Number(pagination?.pageSize || 100);

		const pkBase = params.trace;
		const pk = params.tenantId ? `${params.tenantId}#${pkBase}` : pkBase;

		const filters = [];
		const ExpressionAttributeValues: UnmarshalledAttributes = {
			":PK": pk,
		};

		if (params?.resource?.id) {
			Object.assign(ExpressionAttributeValues, {
				":resourceId": params?.resource?.id,
			});
			filters.push("resourceId=:resourceId");
		}

		if (params?.resource?.type) {
			Object.assign(ExpressionAttributeValues, {
				":resourceType": params?.resource?.type,
			});
			filters.push("resourceType=:resourceType");
		}

		if (params?.app) {
			Object.assign(ExpressionAttributeValues, {
				":app": params.app,
			});
			filters.push("app=:app");
		}

		// Audits with other resources will have a compound id - filter these out
		Object.assign(ExpressionAttributeValues, { ":isParent": "#" });
		filters.push("not contains(SK, :isParent)");

		const { Items: items, LastEvaluatedKey: lastEvaluatedKey } =
			await this.client.send(
				new QueryCommand({
					ScanIndexForward: true,
					IndexName: DynamoDB.Indexes.GSI1_SN,
					ExpressionAttributeValues: marshall(ExpressionAttributeValues),
					ExpressionAttributeNames: {
						"#PK": DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
					},
					KeyConditionExpression: "#PK=:PK",
					TableName: DynamoDB.Table.Name(),
					Limit: pageSize,
					ExclusiveStartKey: startKey ? marshall(startKey) : undefined,
					FilterExpression: filters.join(" AND "),
				}),
			);

		return PaginationCollectionSchema(AuditPayloadSchema).parse({
			items: items?.map((i) =>
				this.transformTraceListItem(unmarshall(i) as TraceListingItem),
			),
			pagination: {
				nextToken: lastEvaluatedKey
					? encodeNextPageToken(unmarshall(lastEvaluatedKey))
					: undefined,
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
			[DynamoDB.Keys.PARTITION_KEY]: (tenantId
				? `${tenantId}#${pkBase}`
				: pkBase) as PK,
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
		const pkBase = [`${app}.${resourceType}`, resourceId]
			.filter(Boolean)
			.join("#");
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
	 * Constructs the TTL attribute for automatic item expiration.
	 *
	 * @param ttlSeconds - Seconds until expiration (defaults to 90 days)
	 * @param date - Base date for TTL calculation (defaults to now)
	 * @returns TTL attribute with Unix timestamp in seconds
	 * @internal
	 */
	private constructTTLAttribute(
		ttlSeconds: number = DEFAULT_TTL,
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
	 * Transforms a raw DynamoDB item into an Audit object.
	 *
	 * Reconstructs the trace string and extracts the clean ID
	 * from compound keys.
	 *
	 * @param item - Raw DynamoDB item with all keys
	 * @returns Parsed and validated Audit object
	 * @internal
	 */
	private transformItem(item: DynamoDBItem) {
		return Promise.resolve(
			AuditSchema.parse({
				trace: `${item.GSI1_SN_PK}:${item.GSI1_SN_SK}`,
				...item,
				id: item.id.split("#").pop(),
			}),
		);
	}

	/**
	 * Transforms a trace listing item into an audit list item payload.
	 *
	 * @param item - Raw trace listing item from GSI1_SN query
	 * @returns Parsed audit list item payload
	 * @internal
	 */
	private transformTraceListItem(item: TraceListingItem) {
		const [id] = item.SK.split("#");

		return AuditListItemPayloadSchema.parse({
			trace: `${item.GSI1_SN_PK}:${item.GSI1_SN_SK}`,
			...item,
			id: id,
		});
	}

	/**
	 * Transforms a resource listing item into an audit list item payload.
	 *
	 * @param item - Raw listing item from GSI1_SS query
	 * @returns Parsed audit list item payload
	 * @internal
	 */
	private transformListItem(item: ListingItem) {
		const [id] = item.SK.split("#");

		return AuditListItemPayloadSchema.parse({
			trace: `${item.GSI1_SN_PK}:${item.GSI1_SN_SK}`,
			...item,
			id: id,
		});
	}
}
