import * as url from "node:url";
import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import { ESMNodeFunctionFactory } from "@nateiler/aws-audit-cdk/lib";
import { SERVICE } from "@nateiler/aws-audit-sdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import { API_RESOURCE } from "./constants.js";

type Props = {
	config: CDKConfig;
	table: dynamodb.ITable;
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
			"Trace",
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
			.addEnvironment("POWERTOOLS_SERVICE_NAME", "Trace");

		// DynamoDB
		props.table.grantReadWriteData(lambda);

		// Integration
		const integration = new apigateway.LambdaIntegration(lambda);

		const RESOURCE = props.restApi.resource
			.addResource(API_RESOURCE.RESOURCE)
			.addResource(`{${API_RESOURCE.RESOURCE}}`);

		// /trace/{trace}
		RESOURCE.addMethod("GET", integration, {
			apiKeyRequired: true,
			operationName: "Retrieve items by trace identifier",
		});
	}
}
