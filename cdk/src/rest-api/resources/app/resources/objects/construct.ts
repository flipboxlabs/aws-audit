import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { RustFunctionFactory } from "../../../../../lambda/rust.function.js";
import { API_RESOURCE } from "./constants.js";
import ReRun from "./resources/rerun/construct.js";

type Props = {
  config: CDKConfig;
  table: dynamodb.ITable;
  eventBus: events.IEventBus;
  /**
   * The bus a rerun sends an event that recorded none to, such as the apps' own
   * global bus, instead of the audit event bus. A handler overrides it by
   * recording its bus with the event (`AuditBatchProcessor`'s `eventBusName`).
   */
  defaultRerunEventBus?: events.IEventBus;
  /**
   * Buses a rerun may send an event to when the event recorded one, besides the
   * audit event bus and `defaultRerunEventBus`.
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
      "Resources",
    ].join("-");

    // Lambda (cdk/rust/lambdas/objects). The id predates the Rust port and stays: a named
    // function whose id changes can't be replaced in place
    const lambdaFn = RustFunctionFactory(props.config)(this, "NodeFunction", {
      binary: "objects",
      functionName: ref,
      layers: props.lambda.layers,
    });

    // Logger / Metrics / Tracing
    lambdaFn.addEnvironment("POWERTOOLS_SERVICE_NAME", "Resource");

    // Audit (it only reads)
    props.table.grantReadData(lambdaFn);

    // Integration
    const integration = new apigateway.LambdaIntegration(lambdaFn);

    const RESOURCE = props.restApi.resource
      .addResource(API_RESOURCE.RESOURCE)
      .addResource(`{${API_RESOURCE.RESOURCE_WILDCARD}}`);

    const ITEM_RESOURCE = RESOURCE.addResource(`{${API_RESOURCE.RESOURCE_WILDCARD_ITEM}}`);
    const AUDIT_RESOURCE = ITEM_RESOURCE.addResource(
      `{${API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT}}`,
    );

    // /apps/{app}/objects/{object}
    RESOURCE.addMethod("GET", integration, {
      apiKeyRequired: true,
      operationName: "List audit object items",
    });

    // /apps/{app}/objects/{object}/{item}
    ITEM_RESOURCE.addMethod("GET", integration, {
      apiKeyRequired: true,
      operationName: "List audit items for resource",
    });

    // /apps/{app}/objects/{object}/{item}/{audit}
    AUDIT_RESOURCE.addMethod("GET", integration, {
      apiKeyRequired: true,
      operationName: "Get audit item detail",
    });

    new ReRun(this, "ReRun", {
      config: props.config,
      table: props.table,
      eventBus: props.eventBus,
      defaultRerunEventBus: props.defaultRerunEventBus,
      rerunEventBuses: props.rerunEventBuses,
      lambda: props.lambda,
      restApi: {
        resource: AUDIT_RESOURCE,
      },
    });
  }
}
