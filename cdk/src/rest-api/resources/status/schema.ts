import {
  AuditListItemPayloadSchema,
  PaginationCollectionSchema,
  Status,
} from "@flipboxlabs/aws-audit-sdk";
import { z } from "zod";
import { auditConfig } from "../../../audit-config.js";
import { API_RESOURCE } from "./constants.js";

export const PathSchema = z.object({
  [API_RESOURCE.RESOURCE]: z.enum(Object.values(Status) as [string, ...string[]]),
});

// Query params use flat keys matching API Gateway's bracket notation
export const QuerySchema = z.object({
  "pagination[pageSize]": z.coerce.number().optional(),
  "pagination[nextToken]": z.string().optional(),
  "filter[app]": auditConfig.schemas.app.optional(),
  "filter[resourceType]": auditConfig.schemas.resourceType.optional(),
});

export const ResponseSchema = PaginationCollectionSchema(AuditListItemPayloadSchema);
