import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import { SERVICE } from "@nateiler/aws-audit-sdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
import Resources from "./resources/construct.js";

type Props = {
	config: CDKConfig;
	table: dynamodb.ITable;
	eventBus: events.IEventBus;
};

export const STAGE_NAME_V1 = "v1";

export default class extends Construct {
	constructor(scope: Construct, id: string, props: Props) {
		super(scope, id);

		const restApi = new apigateway.RestApi(this, "RESTApi", {
			restApiName: [props.config.env.toUpperCase(), SERVICE, "Audit"].join("-"),
			disableExecuteApiEndpoint: false,
			deployOptions: {
				stageName: STAGE_NAME_V1,
				loggingLevel: apigateway.MethodLoggingLevel.INFO,
				metricsEnabled: true,
				description: "Version 1",
				dataTraceEnabled: true,
			},
			retainDeployments: true,
		});

		new Resources(this, "Resources", {
			...props,
			restApi: {
				resource: restApi.root,
			},
		});
	}
}
