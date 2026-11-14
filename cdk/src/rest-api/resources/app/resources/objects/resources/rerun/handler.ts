import {
  BadRequestError,
  InternalServerError,
  NotFoundError,
  Router,
} from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import {
  AuditNotFoundError,
  AuditService,
  BatchHandler,
  EventBridge,
  PutEventsError,
} from "@flipboxlabs/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { type App, auditConfig, type ResourceType } from "../../../../../../../audit-config.js";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../../../constants.js";
import { API_RESOURCE as ITEM_API_RESOURCE } from "../../constants.js";
import { API_RESOURCE } from "./constants.js";
import { PathSchema } from "./schema.js";
import { registerErrorHandlers } from "../../../../../../http/errors.js";
import { NoContentMiddleware } from "../../../../../../http/no-content.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const app = new Router();

app.use(NoContentMiddleware());

app.errorHandler(AuditNotFoundError, () => {
  throw new NotFoundError("Audit not found");
});

const audits = new AuditService(logger, auditConfig);
const eventBus = new BatchHandler(logger, new EventBridgeClient({ logger: logger }));

app.post(
  `/${BASE_API_RESOURCE.RESOURCE}/:${BASE_API_RESOURCE.RESOURCE_WILDCARD}/${ITEM_API_RESOURCE.RESOURCE}/:${ITEM_API_RESOURCE.RESOURCE_WILDCARD}/:${ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM}/:${ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT}/${API_RESOURCE.RESOURCE}`,
  async (reqCtx) => {
    const {
      [BASE_API_RESOURCE.RESOURCE_WILDCARD]: appId,
      [ITEM_API_RESOURCE.RESOURCE_WILDCARD]: resourceType,
      [ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM]: itemId,
      [ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT]: auditId,
    } = reqCtx.valid.req.path;

    const identifiers = {
      app: appId as App,
      resourceType: resourceType as ResourceType,
      id: auditId,
    };
    const item = await audits.getItem(identifiers);

    // The lookup ignores {item}, so an audit of another item is answered as missing.
    // A target without an id can't be matched, so any {item} resolves it.
    if (item.target.id !== undefined && String(item.target.id) !== itemId) {
      throw new AuditNotFoundError(identifiers);
    }

    if (!item.rerunable || !item.event) {
      throw new BadRequestError("Item is not rerunable");
    }

    await eventBus.putEventsOrThrow([
      {
        Source: item.event.source,
        EventBusName: EventBridge.Bus.Name(),
        Detail: item.event.detail,
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

// The event was not re-sent (PutEvents threw or EventBridge rejected the entry).
app.errorHandler(PutEventsError, async (error) => {
  // failedEntries is an enumerable property, so the logged error includes it.
  logger.error("Unable to rerun the event", error);

  return new InternalServerError("Unable to rerun the event").toWebResponse();
});

registerErrorHandlers(app, logger);

export const handler = async (event: unknown, context: Context): Promise<unknown> =>
  app.resolve(event, context);
