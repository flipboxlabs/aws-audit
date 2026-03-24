import { Router } from "@aws-lambda-powertools/event-handler/http";
import { Logger } from "@aws-lambda-powertools/logger";
import { AuditService } from "@nateiler/aws-audit-sdk";
import type { Context } from "aws-lambda";
import { API_RESOURCE } from "./constants.js";
import { PathSchema, QuerySchema, ResponseSchema } from "./schema.js";

const logger = new Logger({
	logRecordOrder: ["level", "message"],
});

const app = new Router();

const audits = new AuditService(logger);

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

		return audits.listTraceItems(
			{
				trace: traceId,
				app: query["filter[app]"],
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
