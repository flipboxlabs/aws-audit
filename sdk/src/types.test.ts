import { describe, expectTypeOf, it } from "vite-plus/test";
import { defineAuditConfig } from "./config.js";
import type {
  TypedIdentifiers,
  TypedListItemsOptions,
  TypedListObjectsOptions,
  TypedResourceFilters,
} from "./repository.js";
import type { InferApp, InferResource, InferResourceType } from "./types.js";

const config = defineAuditConfig({
  apps: { HubSpot: ["Contact", "Company"], CVent: ["Event", "Contact"] },
});
type Config = typeof config;

describe("config types", () => {
  it("should infer each app's resource types", () => {
    expectTypeOf<InferApp<Config>>().toEqualTypeOf<"HubSpot" | "CVent">();
    expectTypeOf<InferResourceType<Config, "HubSpot">>().toEqualTypeOf<"Contact" | "Company">();
    expectTypeOf<InferResourceType<Config>>().toEqualTypeOf<"Contact" | "Company" | "Event">();
    expectTypeOf<InferResource<Config>>().toEqualTypeOf<
      { app: "HubSpot"; type: "Contact" | "Company" } | { app: "CVent"; type: "Event" | "Contact" }
    >();
  });

  it("should narrow a resource type to its app's in typed options", () => {
    expectTypeOf({ id: "a", app: "HubSpot", resourceType: "Company" } as const).toExtend<
      TypedIdentifiers<Config>
    >();
    expectTypeOf({ id: "a", app: "CVent", resourceType: "Company" } as const).not.toExtend<
      TypedIdentifiers<Config>
    >();

    expectTypeOf({ app: "CVent", resource: { type: "Event" } } as const).toExtend<
      TypedListObjectsOptions<Config>
    >();
    expectTypeOf({ app: "HubSpot", resource: { type: "Event" } } as const).not.toExtend<
      TypedListObjectsOptions<Config>
    >();
    expectTypeOf({ app: "HubSpot", resource: { type: "Event", id: 1 } } as const).not.toExtend<
      TypedListItemsOptions<Config>
    >();
  });

  it("should take a resource type of any app without an app filter", () => {
    expectTypeOf({ resource: { type: "Event" } } as const).toExtend<TypedResourceFilters<Config>>();
    expectTypeOf({ app: "HubSpot", resource: { type: "Event" } } as const).not.toExtend<
      TypedResourceFilters<Config>
    >();
  });
});
