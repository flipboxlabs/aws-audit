import { AuditPayloadSchema, PaginationCollectionSchema } from "@flipboxlabs/aws-audit-sdk";
import { z } from "zod";
import { auditConfig } from "../../../audit-config.js";
import { API_RESOURCE } from "./constants.js";

export const PathSchema = z.object({
  [API_RESOURCE.RESOURCE]: z.string(),
});

// Query params use flat keys matching API Gateway's bracket notation
export const QuerySchema = z.object({
  "pagination[pageSize]": z.coerce.number().optional(),
  "pagination[nextToken]": z.string().optional(),
  "filter[app]": auditConfig.schemas.app.optional(),
});

export const ResponseSchema = PaginationCollectionSchema(AuditPayloadSchema);
