import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";
import { RestApiResourcesConstruct as Resources } from "./resources/construct.js";

type Props = {
	config: CDKConfig;
	table: dynamodb.ITable;
	eventBus: events.IEventBus;
	/** Override REST API props. */
	restApi?: Partial<apigateway.RestApiProps>;
};

const DEFAULT_STAGE_NAME_V1 = "v1";

export class RestApiConstruct extends Construct {
	public readonly restApi: apigateway.RestApi;

	constructor(scope: Construct, id: string, props: Props) {
		super(scope, id);

		this.restApi = new apigateway.RestApi(this, "RESTApi", {
			restApiName: [
				props.config.env.toUpperCase(),
				props.config.service,
				"Audit",
			].join("-"),
			disableExecuteApiEndpoint: false,
			retainDeployments: true,
			...props.restApi,
			deployOptions: {
				stageName: DEFAULT_STAGE_NAME_V1,
				loggingLevel: apigateway.MethodLoggingLevel.INFO,
				metricsEnabled: true,
				description: "Version 1",
				dataTraceEnabled: true,
				...props.restApi?.deployOptions,
			},
		});

		new Resources(this, "Resources", {
			...props,
			restApi: {
				resource: this.restApi.root,
			},
		});
	}
}
