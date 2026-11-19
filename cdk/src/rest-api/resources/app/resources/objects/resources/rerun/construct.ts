import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import * as cdk from "aws-cdk-lib";
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
  /**
   * Buses a rerun may send an event to when the event recorded one, besides the
   * audit event bus (an event that recorded none goes to that).
   */
  rerunEventBuses?: events.IEventBus[];
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

    // Put events: on the audit bus, and on any bus an event recorded, which must be
    // one of these (the Lambda resolves a recorded bus against RERUN_EVENT_BUSES)
    const buses = [props.eventBus, ...(props.rerunEventBuses ?? [])];
    // PutEvents doesn't reach another region's bus; the Lambda would refuse it anyway
    const region = cdk.Stack.of(this).region;
    for (const bus of props.rerunEventBuses ?? []) {
      const busRegion = bus.env.region;
      if (
        !cdk.Token.isUnresolved(region) &&
        !cdk.Token.isUnresolved(busRegion) &&
        busRegion !== region
      ) {
        throw new Error(
          `rerunEventBuses: ${bus.eventBusArn} is in ${busRegion}, not the stack's region ${region}; a rerun can only put events on a bus in its own region`,
        );
      }
    }
    for (const bus of buses) {
      bus.grantPutEventsTo(lambdaFn);
    }
    lambdaFn.addEnvironment("RERUN_EVENT_BUSES", buses.map((bus) => bus.eventBusArn).join(","));

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
