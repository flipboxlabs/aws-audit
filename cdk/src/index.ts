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
 * import CloudWatch from "@nateiler/aws-audit-cdk/bootstrap/cloudwatch/construct";
 * import DynamoDB from "@nateiler/aws-audit-cdk/bootstrap/dynamodb/construct";
 * import EventBridge from "@nateiler/aws-audit-cdk/bootstrap/eventbridge/construct";
 * import RestAPI from "@nateiler/aws-audit-cdk/bootstrap/rest-api/construct";
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
