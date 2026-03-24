import * as url from "node:url";
import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import { ESMNodeFunctionFactory } from "@nateiler/aws-audit-cdk/lib";
import { SERVICE } from "@nateiler/aws-audit-sdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
import { API_RESOURCE } from "./constants.js";
import ReRun from "./resources/rerun/construct.js";

type Props = {
	config: CDKConfig;
	table: dynamodb.ITable;
	eventBus: events.IEventBus;
	restApi: {
		resource: apigateway.IResource;
	};
};

export default class extends Construct {
	constructor(scope: Construct, id: string, props: Props) {
		super(scope, id);

		const ref = [
			props.config.env.toUpperCase(),
			"REST-API",
			SERVICE,
			"Resources",
		].join("-");

		// Lambda
		const lambda = ESMNodeFunctionFactory(props.config)(this, "NodeFunction", {
			functionName: ref,
			entry: url.fileURLToPath(
				new URL("handler.ts", import.meta.url).toString(),
			),
			currentVersionOptions: {
				retryAttempts: 1,
			},
		});

		// Logger / Metrics / Tracing
		lambda
			.addEnvironment("POWERTOOLS_METRICS_NAMESPACE", SERVICE)
			.addEnvironment("POWERTOOLS_SERVICE_NAME", "Resource");

		// Audit
		props.table.grantReadWriteData(lambda);

		// Integration
		const integration = new apigateway.LambdaIntegration(lambda);

		const RESOURCE = props.restApi.resource
			.addResource(API_RESOURCE.RESOURCE)
			.addResource(`{${API_RESOURCE.RESOURCE_WILDCARD}}`);

		const ITEM_RESOURCE = RESOURCE.addResource(
			`{${API_RESOURCE.RESOURCE_WILDCARD_ITEM}}`,
		);

		// /apps/{app}/objects/{object}/{item}
		ITEM_RESOURCE.addMethod("GET", integration, {
			apiKeyRequired: true,
			operationName: "List audit items for resource",
		});

		new ReRun(this, "ReRun", {
			config: props.config,
			table: props.table,
			eventBus: props.eventBus,
			restApi: {
				resource: ITEM_RESOURCE.addResource(
					`{${API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT}}`,
				),
			},
		});
	}
}
