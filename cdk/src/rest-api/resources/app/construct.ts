import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import type * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { API_RESOURCE } from "./constants.js";
import Objects from "./resources/objects/construct.js";

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

    new Objects(this, "Objects", {
      config: props.config,
      table: props.table,
      eventBus: props.eventBus,
      lambda: props.lambda,
      restApi: {
        resource: props.restApi.resource
          .addResource(API_RESOURCE.RESOURCE)
          .addResource(`{${API_RESOURCE.RESOURCE_WILDCARD}}`),
      },
    });
  }
}
