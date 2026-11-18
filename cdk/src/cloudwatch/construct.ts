import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import { AUDIT_LOG_IDENTIFIER } from "@flipboxlabs/aws-audit-sdk";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { RustFunctionFactory } from "../lambda/rust.function.js";

type Props = {
  config: CDKConfig;
  table: dynamodb.ITable;
  eventBus: events.IEventBus;
  /** Lambda configuration */
  lambda: {
    /** Lambda layers to attach to the function */
    layers: lambda.ILayerVersion[];
  };

  subscriptionFilter?: {
    /** Scope of the subscription filter policy. Defaults to "ALL". */
    scope?: string;
    /** Selection criteria for log groups. Defaults to excluding the subscription lambda's log group. */
    selectionCriteria?: string;
  };
};

export class CloudWatchConstruct extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const ref = `${[props.config.env.toUpperCase(), "Account", "CloudWatch", "Subscription"].join("-")}`;

    // Lambda Function (Rust: cdk/rust/lambdas/subscription)
    const lambdaFn = RustFunctionFactory(props.config)(this, "subscription", {
      binary: "subscription",
      functionName: ref,
      layers: props.lambda.layers,
      // On the function itself: currentVersionOptions only applies once something
      // reads currentVersion, which nothing here does
      retryAttempts: 2,
    });

    // Writes, and reads an audit back once its related copies are put
    props.table.grantReadWriteData(lambdaFn);

    // Allow puts to EventBridge
    props.eventBus.grantPutEventsTo(lambdaFn);

    // Permissions
    lambdaFn.addPermission("LogProcessorPermission", {
      principal: new ServicePrincipal("logs.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:logs:${props.config.aws.region}:${props.config.aws.account}:log-group:*`,
      sourceAccount: props.config.aws.account,
    });

    // Create an Account-Level Subscription Filter Policy
    const accountPolicy = new logs.CfnAccountPolicy(this, "AccountLevelLogSubscriptionPolicy", {
      policyName: `${props.config.env.toUpperCase()}AccountLevelSubscriptionPolicy`,
      policyType: "SUBSCRIPTION_FILTER_POLICY",
      policyDocument: JSON.stringify({
        DestinationArn: lambdaFn.functionArn,
        Distribution: "Random",
        FilterPattern: `{ $.${AUDIT_LOG_IDENTIFIER}.operation = * }`,
      }),
      scope: props.subscriptionFilter?.scope ?? "ALL",
      selectionCriteria:
        props.subscriptionFilter?.selectionCriteria ??
        `LogGroupName NOT IN ["/aws/lambda/${lambdaFn.functionName}"]`,
    });

    // Add explicit dependency on the Lambda function
    accountPolicy.node.addDependency(lambdaFn);
  }
}
