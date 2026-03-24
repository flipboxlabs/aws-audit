import {
	AuditPayloadSchema,
	PaginationCollectionSchema,
} from "@nateiler/aws-audit-sdk";
import { App, ResourceType } from "@nateiler/aws-audit-sdk/config";
import { z } from "zod";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../constants.js";
import { API_RESOURCE } from "./constants.js";

export const PathSchema = z.object({
	[BASE_API_RESOURCE.RESOURCE_WILDCARD]: z.enum(App),
	[API_RESOURCE.RESOURCE_WILDCARD]: z.enum(ResourceType),
	[API_RESOURCE.RESOURCE_WILDCARD_ITEM]: z.string(),
});

// Query params use flat keys matching API Gateway's bracket notation
export const QuerySchema = z.object({
	"pagination[pageSize]": z.coerce.number().optional(),
	"pagination[nextToken]": z.string().optional(),
});

export const ResponseSchema = PaginationCollectionSchema(AuditPayloadSchema);
