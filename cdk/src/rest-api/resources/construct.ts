import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import type * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as events from "aws-cdk-lib/aws-events";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import App from "./app/construct.js";
import Trace from "./trace/construct.js";

interface Props {
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
    // authorizer: apigateway.IAuthorizer;
  };
}

export class RestApiResourcesConstruct extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    new Trace(this, "Trace", props);

    new App(this, "App", props);
  }
}
