import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import { DynamoDB } from "@flipboxlabs/aws-audit-sdk";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

const ATTRIBUTE_TYPES = {
  string: dynamodb.AttributeType.STRING,
  number: dynamodb.AttributeType.NUMBER,
} as const;

type KeyAttribute = (typeof DynamoDB.Indexes)[keyof typeof DynamoDB.Indexes]["sortKeys"][number];

const attributes = (keys: readonly KeyAttribute[]): dynamodb.Attribute[] =>
  keys.map(({ name, type }) => ({ name, type: ATTRIBUTE_TYPES[type] }));

export default class extends Construct {
  readonly table: dynamodb.Table;

  constructor(
    scope: Construct,
    id: string,
    props: {
      config: CDKConfig;
    },
  ) {
    super(scope, id);

    /**
     * DynamoDB Table
     *
     * A new construct id from the earlier table (`AuditTable`), which had local
     * secondary indexes that can't be removed. That table is retained when it
     * leaves the stack; `aws-audit-migrate` copies its audits here.
     */
    this.table = new dynamodb.Table(this, "AuditTableV2", {
      tableName: DynamoDB.Table.Name(props.config),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: {
        name: DynamoDB.Keys.PARTITION_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: DynamoDB.Keys.SORT_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: DynamoDB.Attributes.TTL,
    });

    // Multi-attribute keys on top-level attributes; each index projects the audit
    // summary a listing returns, less its own keys
    for (const index of Object.values(DynamoDB.Indexes)) {
      const keys = new Set([...index.partitionKeys, ...index.sortKeys].map(({ name }) => name));

      this.table.addGlobalSecondaryIndex({
        indexName: index.name,
        partitionKeys: attributes(index.partitionKeys),
        sortKeys: attributes(index.sortKeys),
        projectionType: dynamodb.ProjectionType.INCLUDE,
        nonKeyAttributes: DynamoDB.Projections.SUMMARY.filter((name) => !keys.has(name)),
      });
    }
  }
}
