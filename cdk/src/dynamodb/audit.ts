import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import { DynamoDB } from "@flipboxlabs/aws-audit-sdk";
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

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
     */
    this.table = new dynamodb.Table(this, "AuditTable", {
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

    /**
     * LSIs (we can't add LSIs later)
     */
    this.table.addLocalSecondaryIndex({
      indexName: DynamoDB.Indexes.LSI1_N,
      sortKey: {
        name: DynamoDB.Keys.LSI1_N_SORT_KEY,
        type: dynamodb.AttributeType.NUMBER,
      },
    });

    this.table.addLocalSecondaryIndex({
      indexName: DynamoDB.Indexes.LSI1_S,
      sortKey: {
        name: DynamoDB.Keys.LSI1_S_SORT_KEY,
        type: dynamodb.AttributeType.STRING,
      },
    });

    // List by Trace Id
    this.table.addGlobalSecondaryIndex({
      indexName: DynamoDB.Indexes.GSI1_SN,
      partitionKey: {
        name: DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: DynamoDB.Keys.GSI1_SN_SORT_KEY,
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "operation",
        "status",
        "message",
        "source",
        "target",
        "rerunable",
        "createdAt",
      ],
    });

    // List by Resource
    this.table.addGlobalSecondaryIndex({
      indexName: DynamoDB.Indexes.GSI1_SS,
      partitionKey: {
        name: DynamoDB.Keys.GSI1_SS_PARTITION_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: DynamoDB.Keys.GSI1_SS_SORT_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "operation",
        "status",
        "message",
        "source",
        "target",
        "rerunable",
        "createdAt",
        DynamoDB.Keys.GSI1_SN_PARTITION_KEY,
        DynamoDB.Keys.GSI1_SN_SORT_KEY,
      ],
    });

    // this.table.addGlobalSecondaryIndex({
    // 	indexName: Indexes.GSI2_SS,
    // 	partitionKey: {
    // 		name: Keys.GSI2_SS_PARTITION_KEY,
    // 		type: dynamodb.AttributeType.STRING,
    // 	},
    // 	sortKey: {
    // 		name: Keys.GSI2_SS_SORT_KEY,
    // 		type: dynamodb.AttributeType.STRING,
    // 	},
    // 	projectionType: dynamodb.ProjectionType.INCLUDE,
    // 	nonKeyAttributes: [
    // 		"operation",
    // 		"status",
    // 		"message",
    // 		"result",
    // 		"error",
    // 		"source",
    // 		"target",
    // 		"rerunable",
    // 		"_createdAt",
    // 	],
    // });
  }
}
