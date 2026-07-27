import { AuditPayloadSchema, PaginationCollectionSchema } from "@flipboxlabs/aws-audit-sdk";
import { z } from "zod";
import { auditConfig } from "../../../../../audit-config.js";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../constants.js";
import { API_RESOURCE } from "./constants.js";

export const ObjectPathSchema = z.object({
  [BASE_API_RESOURCE.RESOURCE_WILDCARD]: auditConfig.schemas.app,
  [API_RESOURCE.RESOURCE_WILDCARD]: auditConfig.schemas.resourceType,
});

export const PathSchema = ObjectPathSchema.extend({
  [API_RESOURCE.RESOURCE_WILDCARD_ITEM]: z.string(),
});

export const DetailPathSchema = PathSchema.extend({
  [API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT]: z.string(),
});

// Query params use flat keys matching API Gateway's bracket notation
export const QuerySchema = z.object({
  "pagination[pageSize]": z.coerce.number().optional(),
  "pagination[nextToken]": z.string().optional(),
});

export const ResponseCollectionSchema = PaginationCollectionSchema(AuditPayloadSchema);
export type ResponseCollection = z.output<typeof ResponseCollectionSchema>;

export const ResponseDetailSchema = AuditPayloadSchema;
export type ResponseDetail = z.output<typeof ResponseDetailSchema>;
