import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import {
	type AnyApp,
	type AnyResourceType,
	AuditService,
} from "@nateiler/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../constants.js";
import { API_RESOURCE } from "./constants.js";
import { PathSchema, QuerySchema, ResponseSchema } from "./schema.js";

const logger = new Logger({
	logRecordOrder: ["level", "message"],
});

const app = new Router();

const audits = new AuditService(logger);

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

		return audits.listItems(
			{
				resource: {
					type: objectType as AnyResourceType,
					id: itemId,
				},
				app: appId as AnyApp,
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

export const handler = async (event: unknown, context: Context) =>
	app.resolve(event, context);
