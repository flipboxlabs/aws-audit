import * as url from "node:url";
import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { ESMNodeFunctionFactory } from "../../../lambda/nodejs.function.js";
import { CDK_VERSION } from "../../../version.js";
import { API_RESOURCE } from "./constants.js";

type Props = {
  config: CDKConfig;
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

    const ref = [props.config.env.toUpperCase(), "REST-API", props.config.service, "Config"].join(
      "-",
    );

    // Lambda (reads the config layer only, so it needs no table or event bus grants)
    const lambdaFn = ESMNodeFunctionFactory(props.config)(this, "NodeFunction", {
      functionName: ref,
      entry: url.fileURLToPath(new URL("handler.js", import.meta.url).toString()),
      layers: props.lambda.layers,
      currentVersionOptions: {
        retryAttempts: 1,
      },
    });

    // Logger / Metrics / Tracing
    lambdaFn.addEnvironment("POWERTOOLS_SERVICE_NAME", "Config");

    // Version reported by GET /config
    lambdaFn.addEnvironment("AWS_AUDIT_CDK_VERSION", CDK_VERSION);

    // Integration
    const integration = new apigateway.LambdaIntegration(lambdaFn);

    const RESOURCE = props.restApi.resource.addResource(API_RESOURCE.RESOURCE);

    // /config
    RESOURCE.addMethod("GET", integration, {
      apiKeyRequired: true,
      operationName: "Retrieve audit configuration",
    });
  }
}
