import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { Status } from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { auditConfig } from "../../../audit-config.js";
import { API_RESOURCE } from "./constants.js";
import { ResponseSchema, type Response as ConfigResponse } from "./schema.js";
import { ResponseValidationMiddleware } from "../../http/response-validation.js";
import { registerErrorHandlers } from "../../http/errors.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const app = new Router();

app.use(ResponseValidationMiddleware());

app.get(
  `/${API_RESOURCE.RESOURCE}`,
  async () => {
    const body: ConfigResponse = {
      apps: [...auditConfig.apps],
      resourceTypes: [...auditConfig.resourceTypes],
      statuses: Object.values(Status),
      // Set by the Config construct from the CDK package version
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

registerErrorHandlers(app, logger);

export const handler = async (event: unknown, context: Context): Promise<unknown> =>
  app.resolve(event, context);
