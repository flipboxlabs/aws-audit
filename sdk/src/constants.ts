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

/**
 * DynamoDB configuration constants for the audit table.
 *
 * Provides table naming, key definitions, index names, and attribute constants
 * used throughout the audit SDK for DynamoDB operations.
 *
 * @example
 * ```typescript
 * // Get table name for production
 * const tableName = DynamoDB.Table.Name({ env: 'prod' });
 * // Returns: "PROD-v1-Audit"
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

    /** GSI1 (String-String) partition key */
    GSI1_SS_PARTITION_KEY: "GSI1_SS_PK",
    /** GSI1 (String-String) sort key */
    GSI1_SS_SORT_KEY: "GSI1_SS_SK",

    /** GSI1 (String-Number) partition key */
    GSI1_SN_PARTITION_KEY: "GSI1_SN_PK",
    /** GSI1 (String-Number) sort key */
    GSI1_SN_SORT_KEY: "GSI1_SN_SK",

    /** LSI1 (String) sort key */
    LSI1_S_SORT_KEY: "LSI1_S_SK",
    /** LSI1 (Numeric) sort key */
    LSI1_N_SORT_KEY: "LSI1_N_SK",
  },
  /** Secondary index names */
  Indexes: {
    /** Global Secondary Index 1 - String partition, String sort */
    GSI1_SS: "GSI1_SS",
    /** Global Secondary Index 1 - String partition, Numeric sort */
    GSI1_SN: "GSI1_SN",

    /** Local Secondary Index 1 - String sort key */
    LSI1_S: "LSI1_S",
    /** Local Secondary Index 1 - Numeric sort key */
    LSI1_N: "LSI1_N",
  },
  /** Special attribute names */
  Attributes: {
    /** Time-to-live attribute for automatic item expiration */
    TTL: "ttl",
  },
} as const;

/**
 * Builds a DynamoDB table name from service name and configuration.
 *
 * Format: `{ENV}-{service}-Audit` (e.g., "PROD-v1-Audit")
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
  return [`${config.env.toUpperCase()}`, config.service, "Audit"].filter(Boolean).join("-");
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
