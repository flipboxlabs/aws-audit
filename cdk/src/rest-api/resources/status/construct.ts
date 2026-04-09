import * as url from "node:url";
import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { ESMNodeFunctionFactory } from "../../../lambda/nodejs.function.js";
import { API_RESOURCE } from "./constants.js";

type Props = {
  config: CDKConfig;
  table: dynamodb.ITable;
  /** Lambda configuration */
  lambda: {
    /** Lambda layers to attach to the function */
    layers: lambda.ILayerVersion[];
  };
  restApi: {
    resource: apigateway.IResource;
  };
};

export default class extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const ref = [props.config.env.toUpperCase(), "REST-API", props.config.service, "Status"].join(
      "-",
    );

    // Lambda
    const lambdaFn = ESMNodeFunctionFactory(props.config)(this, "NodeFunction", {
      functionName: ref,
      entry: url.fileURLToPath(new URL("handler.js", import.meta.url).toString()),
      layers: props.lambda.layers,
      currentVersionOptions: {
        retryAttempts: 1,
      },
    });

    // Logger / Metrics / Tracing
    lambdaFn.addEnvironment("POWERTOOLS_SERVICE_NAME", "Status");

    // DynamoDB
    props.table.grantReadData(lambdaFn);

    // Integration
    const integration = new apigateway.LambdaIntegration(lambdaFn);

    const RESOURCE = props.restApi.resource
      .addResource(API_RESOURCE.RESOURCE)
      .addResource(`{${API_RESOURCE.RESOURCE}}`);

    // /status/{status}
    RESOURCE.addMethod("GET", integration, {
      apiKeyRequired: true,
      operationName: "Retrieve audit items by status",
    });
  }
}
