import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Status } from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { auditConfig } from "../../../audit-config.js";
import { API_RESOURCE } from "./constants.js";
import { ResponseSchema, type Response as ConfigResponse } from "./schema.js";
import { ResponseValidationMiddleware } from "../../http/response-validation.js";

const app = new Router();

app.use(ResponseValidationMiddleware());

app.get(
  `/${API_RESOURCE.RESOURCE}`,
  async () => {
    const body: ConfigResponse = {
      apps: [...auditConfig.apps],
      resourceTypes: [...auditConfig.resourceTypes],
      statuses: Object.values(Status),
      // Replaced with a string literal at bundle time (see ESMNodeFunctionFactory)
      version: process.env.AWS_AUDIT_CDK_VERSION as string,
    };

    return Response.json(body, { status: 200 }) as unknown as ConfigResponse;
  },
  {
    validation: {
      res: {
        body: ResponseSchema,
      },
    },
  },
);

export const handler = async (event: unknown, context: Context): Promise<unknown> =>
  app.resolve(event, context);
