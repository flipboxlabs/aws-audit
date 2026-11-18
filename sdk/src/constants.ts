/**
 * Identifier key used in CloudWatch structured logs to mark audit entries.
 *
 * When this key is present in a log object, it signals to log processors
 * that the entry is an audit record that should be captured and stored.
 *
 * @example
 * ```typescript
 * const logEntry = {
 *   [AUDIT_LOG_IDENTIFIER]: true,
 *   operation: 'createUser',
 *   // ...audit data
 * };
 * ```
 */
export const AUDIT_LOG_IDENTIFIER = "_audit";

/**
 * Configuration for generating resource names.
 */
type NameConfig = {
  /** Environment name (e.g., 'dev', 'staging', 'prod') */
  env: string;

  /** Service name used in naming resources */
  service?: string;
};

/**
 * Configuration for generating AWS resource ARNs.
 * Extends NameConfig with AWS-specific identifiers.
 */
type ARNConfig = NameConfig & {
  /** AWS account and region information */
  aws: {
    /** AWS region (e.g., 'us-east-1') */
    region: string;
    /** AWS account ID */
    account: string;
  };
};

/** A key attribute's DynamoDB type */
export type KeyAttributeType = "string" | "number";

/** A key attribute of a secondary index, with its DynamoDB type */
export type KeyAttribute = { readonly name: string; readonly type: KeyAttributeType };

/** A global secondary index with multi-attribute keys */
export type IndexDefinition = {
  readonly name: string;
  readonly partitionKeys: readonly KeyAttribute[];
  readonly sortKeys: readonly KeyAttribute[];
  /** Attributes a listing filters on, projected beside the summary */
  readonly filters?: readonly string[];
};

/** Top-level attributes the secondary index keys are built from */
const Attributes = {
  /** Time-to-live attribute for automatic item expiration */
  TTL: "ttl",
  /** The audit's `tenantId`, or {@link NO_TENANT} without one */
  TENANT_KEY: "tenantKey",
  /** The item's `target.app` */
  APP: "app",
  /** The item's `target.type` */
  RESOURCE_TYPE: "resourceType",
  /** The item's `target.id`, as a string; absent when the target has none */
  RESOURCE_ID: "resourceId",
  /** `audit` on an audit; a copy under a related resource has none, so `ByStatus` holds audits only */
  KIND: "kind",
  /** The trace id from `trace`; only audits with a trace have it */
  TRACE_ID: "traceId",
  /** The trace stage from `trace`, a number */
  TRACE_STAGE: "traceStage",
  /**
   * String set of what the status and trace filters match on, for the target and
   * each related resource: `{app}`, `{app}#{type}`, `*#{type}` and, with an id,
   * `{app}#{type}#{id}`; `%`, `#` and `*` in each part are escaped as `%25`, `%23`
   * and `%2A`
   */
  SCOPES: "scopes",
  STATUS: "status",
  CREATED_AT: "createdAt",
  ID: "id",
} as const;

const key = (name: string, type: KeyAttributeType = "string"): KeyAttribute => ({ name, type });

/** Newest first, then by id so audits created in the same millisecond keep an order */
const BY_CREATION = [key(Attributes.CREATED_AT), key(Attributes.ID)];

/**
 * DynamoDB configuration constants for the audit table.
 *
 * Provides table naming, key definitions, index definitions, and attribute constants
 * used throughout the audit SDK for DynamoDB operations.
 *
 * Items:
 * - An audit: `PK` `{tenantKey}#{app}#{type}#{id}`, `SK` `audit`, with
 *   {@link DynamoDB.NO_TENANT} as the `tenantKey` of an audit without a tenant
 * - A copy of it per related resource, in the same partition: `SK`
 *   `related#{app}#{type}#{resourceId}`, with the resource as `target` and the
 *   audit's target as `source`
 *
 * Each part of a key is escaped: `%`, `#` and `*` as `%25`, `%23` and `%2A`, so
 * distinct parts never join to the same key.
 *
 * The indexes use multi-attribute keys built from top-level attributes
 * ({@link DynamoDB.Attributes}), and each projects {@link DynamoDB.Projections.SUMMARY}
 * and the attributes its listing filters on.
 *
 * @example
 * ```typescript
 * // Get table name for production
 * const tableName = DynamoDB.Table.Name({ env: 'prod', service: 'v1' });
 * // Returns: "PROD-v1-Audit-v2"
 *
 * // Access key names
 * const pk = DynamoDB.Keys.PARTITION_KEY; // "PK"
 * const sk = DynamoDB.Keys.SORT_KEY; // "SK"
 * ```
 */
export const DynamoDB = {
  /** Table name and ARN generators */
  Table: {
    /** Generates the DynamoDB table name based on environment */
    Name: (config?: NameConfig) => buildDynamoDBName(config),
    /** Generates the full DynamoDB table ARN */
    ARN: (config?: ARNConfig) => buildDynamoDBArn(config),
  },
  /** DynamoDB key attribute names */
  Keys: {
    /** Primary partition key */
    PARTITION_KEY: "PK",
    /** Primary sort key */
    SORT_KEY: "SK",
  },
  /** Sort key values */
  SortKeys: {
    /** The audit itself */
    AUDIT: "audit",
    /** Prefix of a related-resource copy: `related#{app}#{type}#{resourceId}` */
    RELATED_PREFIX: "related#",
  },
  /** What an item is: an audit, which gets the `kind` attribute, or a related resource's copy */
  Kinds: {
    AUDIT: "audit",
    RELATED: "related",
  },
  /** `tenantKey` of an audit without a tenant, in its `PK` too: index key attributes must be present */
  NO_TENANT: "-",
  Attributes,
  /** Global secondary indexes */
  Indexes: {
    /** Audits and related-resource copies of a resource type, newest first */
    BY_TYPE: {
      name: "ByType",
      partitionKeys: [
        key(Attributes.TENANT_KEY),
        key(Attributes.APP),
        key(Attributes.RESOURCE_TYPE),
      ],
      sortKeys: BY_CREATION,
    },
    /** Audits and related-resource copies of a resource, newest first */
    BY_RESOURCE: {
      name: "ByResource",
      partitionKeys: [
        key(Attributes.TENANT_KEY),
        key(Attributes.APP),
        key(Attributes.RESOURCE_TYPE),
        key(Attributes.RESOURCE_ID),
      ],
      sortKeys: BY_CREATION,
    },
    /** Audits by status, newest first; sparse, since copies have no `kind` */
    BY_STATUS: {
      name: "ByStatus",
      partitionKeys: [key(Attributes.TENANT_KEY), key(Attributes.STATUS), key(Attributes.KIND)],
      sortKeys: BY_CREATION,
      // Resource filters match the audit's scopes; a query sees only what's projected
      filters: [Attributes.SCOPES],
    },
    /** Audits by trace, by stage then creation; sparse, since copies have no trace id */
    BY_TRACE: {
      name: "ByTrace",
      partitionKeys: [key(Attributes.TENANT_KEY), key(Attributes.TRACE_ID)],
      sortKeys: [key(Attributes.TRACE_STAGE, "number"), ...BY_CREATION],
      filters: [Attributes.SCOPES],
    },
  },
  /** Index projections */
  Projections: {
    /**
     * Every attribute of the summary a listing returns
     * (`AuditSummarySchema`). Each index projects those that aren't its keys.
     */
    SUMMARY: [
      "id",
      "tenantId",
      "status",
      "tier",
      "operation",
      "message",
      "target",
      "source",
      "rerunable",
      "related",
      "trace",
      "createdAt",
      "updatedAt",
    ],
  },
} as const satisfies { Indexes: Record<string, IndexDefinition> } & Record<string, unknown>;

/**
 * Builds a DynamoDB table name from service name and configuration.
 *
 * Format: `{ENV}-{service}-Audit-v2` (e.g., "PROD-v1-Audit-v2"). The earlier table,
 * `{ENV}-{service}-Audit`, had another layout; `aws-audit-migrate` copies it.
 *
 * @param name - Service name to include in table name
 * @param config - Environment configuration (defaults to process.env.ENVIRONMENT)
 * @returns Formatted table name string
 * @internal
 */
function buildDynamoDBName(
  config: NameConfig = {
    env: String(process.env.ENVIRONMENT),
    service: process.env.SERVICE,
  },
): string {
  return [`${config.env.toUpperCase()}`, config.service, "Audit-v2"].filter(Boolean).join("-");
}

/**
 * Builds a DynamoDB table ARN from service name and AWS configuration.
 *
 * @param name - Service name to include in table name
 * @param config - AWS and environment configuration
 * @returns Full DynamoDB table ARN
 * @internal
 */
function buildDynamoDBArn(
  config: ARNConfig = {
    aws: {
      region: String(process.env.AWS_REGION),
      account: String(process.env.AWS_ACCOUNT),
    },
    env: String(process.env.ENVIRONMENT),
    service: process.env.SERVICE,
  },
): string {
  return `arn:aws:dynamodb:${config.aws.region}:${config.aws.account}:table/${buildDynamoDBName({ env: config.env, service: config.service })}`;
}

/**
 * EventBridge configuration constants for the audit event bus.
 *
 * Provides bus naming, event source identifiers, and detail type constants
 * used for publishing audit events to EventBridge.
 *
 * @example
 * ```typescript
 * // Get event bus name
 * const busName = EventBridge.Bus.Name({ env: 'prod' });
 * // Returns: "PROD-v1-Audit"
 *
 * // Use event types
 * const event = {
 *   Source: EventBridge.Source,
 *   DetailType: EventBridge.DetailType.UPSERTED,
 *   Detail: JSON.stringify(auditData),
 * };
 * ```
 */
export const EventBridge = {
  /** Event bus name and ARN generators */
  Bus: {
    /** Generates the EventBridge bus name based on environment */
    Name: (config?: NameConfig) => buildEventBridgeName(config),
    /** Generates the full EventBridge bus ARN */
    ARN: (config?: ARNConfig) => buildEventBridgeArn(config),
  },
  /** Source identifier for audit events */
  Source: "Audit",
  /** Event detail types for different audit operations */
  DetailType: {
    /** Emitted when an audit record is created or updated */
    UPSERTED: "Upserted",
    /** Emitted when an audit record is deleted */
    DELETED: "Deleted",
  },
} as const;

/**
 * Union type of all valid EventBridge detail types.
 */
export type AnyEventBridgeDetailType =
  (typeof EventBridge.DetailType)[keyof typeof EventBridge.DetailType];

/**
 * Builds an EventBridge bus name from service name and configuration.
 *
 * Format: `{ENV}-{service}-Audit` (e.g., "PROD-v1-Audit")
 *
 * @param name - Service name to include in bus name
 * @param config - Environment configuration (defaults to process.env.ENVIRONMENT)
 * @returns Formatted bus name string
 * @internal
 */
function buildEventBridgeName(
  config: NameConfig = {
    env: String(process.env.ENVIRONMENT),
    service: process.env.SERVICE,
  },
): string {
  return [`${config.env.toUpperCase()}`, config.service, "Audit"].filter(Boolean).join("-");
}

/**
 * Builds an EventBridge bus ARN from service name and AWS configuration.
 *
 * @param name - Service name to include in bus name
 * @param config - AWS and environment configuration
 * @returns Full EventBridge bus ARN
 * @internal
 */
function buildEventBridgeArn(
  config: ARNConfig = {
    aws: {
      region: process.env.AWS_REGION ?? "us-east-1",
      account: String(process.env.AWS_ACCOUNT),
    },
    env: String(process.env.ENVIRONMENT),
    service: process.env.SERVICE,
  },
): string {
  return `arn:aws:events:${config.aws.region}:${config.aws.account}:event-bus/${buildEventBridgeName({ env: config.env, service: config.service })}`;
}
