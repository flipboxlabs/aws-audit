import * as url from "node:url";
import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import { ESMNodeFunctionFactory } from "@nateiler/aws-audit-cdk/lib";
import { AUDIT_LOG_IDENTIFIER } from "@nateiler/aws-audit-sdk";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export default class extends Construct {
	constructor(
		scope: Construct,
		id: string,
		props: {
			config: CDKConfig;
			table: dynamodb.ITable;
			eventBus: events.IEventBus;
		},
	) {
		super(scope, id);

		const ref = `${[props.config.env.toUpperCase(), "Account", "CloudWatch", "Subscription"].join("-")}`;

		// Lambda Function
		const lambda = ESMNodeFunctionFactory(props.config)(this, "subscription", {
			functionName: ref,
			entry: url.fileURLToPath(
				new URL("subscription.handler.ts", import.meta.url).toString(),
			),
			currentVersionOptions: {
				retryAttempts: 2,
			},
		});

		// Allow writes to DynamoDB
		props.table.grantWriteData(lambda);

		// Allow puts to EventBridge
		props.eventBus.grantPutEventsTo(lambda);

		// Permissions
		lambda.addPermission("LogProcessorPermission", {
			principal: new ServicePrincipal("logs.amazonaws.com"),
			action: "lambda:InvokeFunction",
			sourceArn: `arn:aws:logs:${props.config.aws.region}:${props.config.aws.account}:log-group:*`,
			sourceAccount: props.config.aws.account,
		});

		// Create an Account-Level Subscription Filter Policy
		const accountPolicy = new logs.CfnAccountPolicy(
			this,
			"AccountLevelLogSubscriptionPolicy",
			{
				policyName: `${props.config.env.toUpperCase()}AccountLevelSubscriptionPolicy`,
				policyType: "SUBSCRIPTION_FILTER_POLICY",
				policyDocument: JSON.stringify({
					DestinationArn: lambda.functionArn,
					Distribution: "Random",
					FilterPattern: `{ $.${AUDIT_LOG_IDENTIFIER}.operation = * }`,
				}),
				scope: "ALL", // Applies to all log groups in the account
				selectionCriteria: `LogGroupName NOT IN ["/aws/lambda/${lambda.functionName}"]`, // Filter logs
			},
		);

		// Add explicit dependency on the Lambda function
		accountPolicy.node.addDependency(lambda);
	}
}
