import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { RustFunctionFactory } from "../../../lambda/rust.function.js";
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

    const ref = [props.config.env.toUpperCase(), "REST-API", props.config.service, "Trace"].join(
      "-",
    );

    // Lambda (cdk/rust/lambdas/trace). The id predates the Rust port and stays: a named
    // function whose id changes can't be replaced in place
    const lambdaFn = RustFunctionFactory(props.config)(this, "NodeFunction", {
      binary: "trace",
      functionName: ref,
      layers: props.lambda.layers,
    });

    // Logger / Metrics / Tracing
    lambdaFn.addEnvironment("POWERTOOLS_SERVICE_NAME", "Trace");

    // DynamoDB (it only lists)
    props.table.grantReadData(lambdaFn);

    // Integration
    const integration = new apigateway.LambdaIntegration(lambdaFn);

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
