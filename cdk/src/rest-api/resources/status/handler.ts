import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { type AnyStatus, AuditService } from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { type App, auditConfig, type ResourceType } from "../../../audit-config.js";
import { API_RESOURCE } from "./constants.js";
import { PathSchema, QuerySchema, ResponseSchema } from "./schema.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const app = new Router();

const audits = new AuditService(logger, auditConfig);

app.get(
  `/${API_RESOURCE.RESOURCE}/:${API_RESOURCE.RESOURCE}`,
  async (reqCtx) => {
    const { [API_RESOURCE.RESOURCE]: status } = reqCtx.valid.req.path;
    const query = reqCtx.valid.req.query;

    const pagination =
      query["pagination[pageSize]"] || query["pagination[nextToken]"]
        ? {
            pageSize: query["pagination[pageSize]"],
            nextToken: query["pagination[nextToken]"],
          }
        : undefined;

    return audits.listByStatus(
      {
        status: status as AnyStatus,
        app: query["filter[app]"] as App | undefined,
        resource: query["filter[resourceType]"]
          ? { type: query["filter[resourceType]"] as ResourceType }
          : undefined,
      },
      pagination,
    );
  },
  {
    validation: {
      req: {
        path: PathSchema,
        query: QuerySchema,
      },
      res: {
        body: ResponseSchema,
      },
    },
  },
);

export const handler = async (event: unknown, context: Context): Promise<unknown> =>
  app.resolve(event, context);
