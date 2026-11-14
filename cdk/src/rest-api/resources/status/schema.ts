import { AuditPayloadSchema, PaginationCollectionSchema, Status } from "@flipboxlabs/aws-audit-sdk";
import { z } from "zod";
import { auditConfig } from "../../../audit-config.js";
import { PaginationQuerySchema } from "../../http/pagination.js";
import { API_RESOURCE } from "./constants.js";

export const PathSchema = z.object({
  [API_RESOURCE.RESOURCE]: z.enum(Object.values(Status) as [string, ...string[]]),
});

// Query params use flat keys matching API Gateway's bracket notation
export const QuerySchema = PaginationQuerySchema.extend({
  "filter[app]": auditConfig.schemas.app.optional(),
  "filter[resourceType]": auditConfig.schemas.resourceType.optional(),
});

export const ResponseCollectionSchema = PaginationCollectionSchema(AuditPayloadSchema);
export type ResponseCollection = z.output<typeof ResponseCollectionSchema>;
