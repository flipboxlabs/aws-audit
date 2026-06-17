import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { AuditService } from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { type App, auditConfig, type ResourceType } from "../../../../../audit-config.js";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../constants.js";
import { API_RESOURCE } from "./constants.js";
import {
  DetailPathSchema,
  ResponseDetailSchema,
  PathSchema,
  QuerySchema,
  ResponseCollectionSchema,
  ResponseCollection,
  ResponseDetail,
} from "./schema.js";
import { ResponseValidationMiddleware } from "../../../../http/response-validation.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const app = new Router();

app.use(ResponseValidationMiddleware());

const audits = new AuditService(logger, auditConfig);

app.get(
  `/${BASE_API_RESOURCE.RESOURCE}/:${BASE_API_RESOURCE.RESOURCE_WILDCARD}/${API_RESOURCE.RESOURCE}/:${API_RESOURCE.RESOURCE_WILDCARD}/:${API_RESOURCE.RESOURCE_WILDCARD_ITEM}`,
  async (reqCtx) => {
    const {
      [BASE_API_RESOURCE.RESOURCE_WILDCARD]: appId,
      [API_RESOURCE.RESOURCE_WILDCARD]: objectType,
      [API_RESOURCE.RESOURCE_WILDCARD_ITEM]: itemId,
    } = reqCtx.valid.req.path;
    const query = reqCtx.valid.req.query;

    const pagination =
      query["pagination[pageSize]"] || query["pagination[nextToken]"]
        ? {
            pageSize: query["pagination[pageSize]"],
            nextToken: query["pagination[nextToken]"],
          }
        : undefined;

    const collection = await audits.listItems(
      {
        resource: {
          type: objectType as ResourceType,
          id: itemId,
        },
        app: appId as App,
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

app.get(
  `/${BASE_API_RESOURCE.RESOURCE}/:${BASE_API_RESOURCE.RESOURCE_WILDCARD}/${API_RESOURCE.RESOURCE}/:${API_RESOURCE.RESOURCE_WILDCARD}/:${API_RESOURCE.RESOURCE_WILDCARD_ITEM}/:${API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT}`,
  async (reqCtx) => {
    const {
      [BASE_API_RESOURCE.RESOURCE_WILDCARD]: appId,
      [API_RESOURCE.RESOURCE_WILDCARD]: objectType,
      [API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT]: auditId,
    } = reqCtx.valid.req.path;

    const item = await audits.getItem({
      app: appId as App,
      resourceType: objectType as ResourceType,
      id: auditId,
    });

    return Response.json(item, { status: 200 }) as unknown as ResponseDetail;
  },
  {
    validation: {
      req: {
        path: DetailPathSchema,
      },
      res: {
        body: ResponseDetailSchema,
      },
    },
  },
);

export const handler = async (event: unknown, context: Context): Promise<unknown> =>
  app.resolve(event, context);
