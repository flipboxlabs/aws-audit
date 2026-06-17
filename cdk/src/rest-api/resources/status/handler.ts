import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { type AnyStatus, AuditService } from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { type App, auditConfig, type ResourceType } from "../../../audit-config.js";
import { API_RESOURCE } from "./constants.js";
import { PathSchema, QuerySchema, ResponseCollectionSchema, ResponseCollection } from "./schema.js";
import { ResponseValidationMiddleware } from "../../http/response-validation.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const app = new Router();

app.use(ResponseValidationMiddleware());

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

    const collection = await audits.listByStatus(
      {
        status: status as AnyStatus,
        app: query["filter[app]"] as App | undefined,
        resource: query["filter[resourceType]"]
          ? { type: query["filter[resourceType]"] as ResourceType }
          : undefined,
      },
      pagination,
    );

    return Response.json(collection, { status: 200 }) as unknown as ResponseCollection;
  },
  {
    validation: {
      req: {
        path: PathSchema,
        query: QuerySchema,
      },
      res: {
        body: ResponseCollectionSchema,
      },
    },
  },
);

export const handler = async (event: unknown, context: Context): Promise<unknown> =>
  app.resolve(event, context);
