import { App, ResourceType } from "@nateiler/aws-audit-sdk/config";
import { z } from "zod";
import { API_RESOURCE as BASE_API_RESOURCE } from "../../../../constants.js";
import { API_RESOURCE as ITEM_API_RESOURCE } from "../../constants.js";

export const PathSchema = z.object({
	[BASE_API_RESOURCE.RESOURCE_WILDCARD]: z.enum(App),
	[ITEM_API_RESOURCE.RESOURCE_WILDCARD]: z.enum(ResourceType),
	[ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM]: z.string(),
	[ITEM_API_RESOURCE.RESOURCE_WILDCARD_ITEM_AUDIT]: z.string(),
});
