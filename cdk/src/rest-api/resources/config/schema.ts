import { Status } from "@flipboxlabs/aws-audit-sdk";
import { z } from "zod";
import { auditConfig } from "../../../audit-config.js";

export const ResponseSchema = z.object({
  apps: z.array(auditConfig.schemas.app),
  resourceTypes: z.array(auditConfig.schemas.resourceType),
  statuses: z.array(z.enum(Object.values(Status) as [string, ...string[]])),
  version: z.string().min(1),
});
export type Response = z.output<typeof ResponseSchema>;
