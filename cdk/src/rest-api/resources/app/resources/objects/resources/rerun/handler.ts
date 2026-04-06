import { BadRequestError, Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { AuditService, BatchHandler, EventBridge } from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { type App, auditConfig, type ResourceType } from "../../../../../../../audit-config.js";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../../../constants.js";
import { API_RESOURCE as ITEM_API_RESOURCE } from "../../constants.js";
import { API_RESOURCE } from "./constants.js";
import { PathSchema } from "./schema.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const app = new Router();

const audits = new AuditService(logger, auditConfig);
const eventBus = new BatchHandler(logger, new EventBridgeClient({ logger: logger }));

app.post(
  `/${BASE_API_RESOURCE.RESOURCE}/:${BASE_API_RESOURCE.RESOURCE_WILDCARD}/${ITEM_API_RESOURCE.RESOURCE}/:${ITEM_API_RESOURCE.RESOURCE_WILDCARD}/:${ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM}/:${ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT}/${API_RESOURCE.RESOURCE}`,
  async (reqCtx) => {
    const {
      [BASE_API_RESOURCE.RESOURCE_WILDCARD]: appId,
      [ITEM_API_RESOURCE.RESOURCE_WILDCARD]: resourceType,
      [ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT]: auditId,
    } = reqCtx.valid.req.path;

    const item = await audits.getItem({
      app: appId as App,
      resourceType: resourceType as ResourceType,
      id: auditId,
    });

    if (!item.rerunable || !item.event) {
      throw new BadRequestError("Item is not rerunable");
    }

    await eventBus.putEvents([
      {
        Source: item.event.source,
        EventBusName: EventBridge.Bus.Name(),
        Detail: JSON.stringify(item.event.detail),
        DetailType: item.event["detail-type"],
      },
    ]);

    return new Response(undefined, {
      status: 204,
    });
  },
  {
    validation: {
      req: {
        path: PathSchema,
      },
    },
  },
);

export const handler = async (event: unknown, context: Context): Promise<unknown> =>
  app.resolve(event, context);
