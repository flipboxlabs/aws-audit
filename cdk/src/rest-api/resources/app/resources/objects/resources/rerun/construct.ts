import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { RustFunctionFactory } from "../../../../../../../lambda/rust.function.js";
import { API_RESOURCE } from "./constants.js";

type Props = {
  config: CDKConfig;
  table: dynamodb.ITable;
  eventBus: events.IEventBus;
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

    const ref = [
      props.config.env.toUpperCase(),
      "REST-API",
      props.config.service,
      "Resource-Rerun",
    ].join("-");

    // Lambda (cdk/rust/lambdas/rerun). The id predates the Rust port and stays: a named
    // function whose id changes can't be replaced in place
    const lambdaFn = RustFunctionFactory(props.config)(this, "NodeFunction", {
      binary: "rerun",
      functionName: ref,
      layers: props.lambda.layers,
    });

    // Logger / Metrics / Tracing
    lambdaFn.addEnvironment("POWERTOOLS_SERVICE_NAME", "ResourceRerun");

    // Audit (it reads the audit, then sends its event)
    props.table.grantReadData(lambdaFn);

    // Put events
    props.eventBus.grantPutEventsTo(lambdaFn);

    // Integration
    const integration = new apigateway.LambdaIntegration(lambdaFn);

    const RESOURCE = props.restApi.resource.addResource(API_RESOURCE.RESOURCE);

    // /apps/{app}/objects/{object}/{item}/{audit}/rerun
    RESOURCE.addMethod("POST", integration, {
      apiKeyRequired: true,
      operationName: "Rerun the event",
    });
  }
}
