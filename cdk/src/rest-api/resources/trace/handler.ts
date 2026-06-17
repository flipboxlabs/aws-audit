import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { AuditService } from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { type App, auditConfig } from "../../../audit-config.js";
import { API_RESOURCE } from "./constants.js";
import {
  PathSchema,
  QuerySchema,
  ResponseCollectionSchema,
  type ResponseCollection,
} from "./schema.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const app = new Router();

const audits = new AuditService(logger, auditConfig);

app.get(
  `/${API_RESOURCE.RESOURCE}/:${API_RESOURCE.RESOURCE}`,
  async (reqCtx) => {
    const { [API_RESOURCE.RESOURCE]: traceId } = reqCtx.valid.req.path;
    const query = reqCtx.valid.req.query;

    const pagination =
      query["pagination[pageSize]"] || query["pagination[nextToken]"]
        ? {
            pageSize: query["pagination[pageSize]"],
            nextToken: query["pagination[nextToken]"],
          }
        : undefined;

    const collection = await audits.listTraceItems(
      {
        trace: traceId,
        app: query["filter[app]"] as App | undefined,
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
