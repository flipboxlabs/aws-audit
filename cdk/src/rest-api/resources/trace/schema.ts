import {
	AuditPayloadSchema,
	PaginationCollectionSchema,
} from "@nateiler/aws-audit-sdk";
import { App } from "@nateiler/aws-audit-sdk/config";
import { z } from "zod";
import { API_RESOURCE } from "./constants.js";

export const PathSchema = z.object({
	[API_RESOURCE.RESOURCE]: z.string(),
});

// Query params use flat keys matching API Gateway's bracket notation
export const QuerySchema = z.object({
	"pagination[pageSize]": z.coerce.number().optional(),
	"pagination[nextToken]": z.string().optional(),
	"filter[app]": z.enum(App).optional(),
});

export const ResponseSchema = PaginationCollectionSchema(AuditPayloadSchema);
