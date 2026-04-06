import { z } from "zod";
import { auditConfig } from "../../../../../../../audit-config.js";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../../../constants.js";
import { API_RESOURCE as ITEM_API_RESOURCE } from "../../constants.js";

export const PathSchema = z.object({
  [BASE_API_RESOURCE.RESOURCE_WILDCARD]: auditConfig.schemas.app,
  [ITEM_API_RESOURCE.RESOURCE_WILDCARD]: auditConfig.schemas.resourceType,
  [ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM]: z.string(),
  [ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT]: z.string(),
});
