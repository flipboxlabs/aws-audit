/**
 * AWS Audit CDK Library
 *
 * Provides constructs for deploying audit infrastructure. Import and compose
 * the constructs in your own stack as needed.
 *
 * @example
 * ```typescript
 * import * as cdk from "aws-cdk-lib";
 * import type { Construct } from "constructs";
 * import type { CDKConfig } from "@nateiler/aws-audit-cdk";
 *
 * // Import constructs from the bootstrap directory
 * import { CloudWatchConstruct as CloudWatch } from "@nateiler/aws-audit-cdk/cloudwatch";
 * import { DynamoDBConstruct as DynamoDB } from "@nateiler/aws-audit-cdk/dynamodb";
 * import { EventBridgeConstruct as EventBridge } from "@nateiler/aws-audit-cdk/eventbridge";
 * import { RestApiConstruct as RestAPI } from "@nateiler/aws-audit-cdk/rest-api";
 *
 * interface Props {
 *   config: CDKConfig;
 * }
 *
 * export class AuditStack extends cdk.NestedStack {
 *   constructor(scope: Construct, id: string, props: Props) {
 *     super(scope, id, { description: "Audit" });
 *
 *     // DynamoDB (storage)
 *     const { table } = new DynamoDB(this, "DynamoDB", { config: props.config });
 *
 *     // EventBridge (events)
 *     const { eventBus } = new EventBridge(this, "EventBridge", {
 *       config: props.config,
 *     });
 *
 *     // CloudWatch (logging subscription)
 *     new CloudWatch(this, "CloudWatch", {
 *       config: props.config,
 *       table,
 *       eventBus,
 *     });
 *
 *     // REST API (optional)
 *     new RestAPI(this, "RestAPI", {
 *       config: props.config,
 *       table,
 *       eventBus,
 *     });
 *   }
 * }
 * ```
 */

export * from "./constants.js";
