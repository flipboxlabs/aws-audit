import { defineAuditConfig } from "./config.js";

/**
 * Test configuration for SDK tests.
 * Provides sample apps and their resource types for testing; TestApp has no
 * Unknown.
 */
export const testConfig = defineAuditConfig({
  apps: {
    App1: ["Unknown", "User", "Order"],
    TestApp: ["User", "Order"],
  },
});

/**
 * Type alias for the App union type from the test config.
 */
export type App = (typeof testConfig)["_types"]["App"];

/**
 * Type alias for the ResourceType union type from the test config.
 */
export type ResourceType = (typeof testConfig)["_types"]["ResourceType"];

/**
 * Enum-like object for App values in tests.
 */
export const App = {
  App1: "App1",
  TestApp: "TestApp",
} as const;

/**
 * Enum-like object for ResourceType values in tests.
 */
export const ResourceType = {
  UNKNOWN: "Unknown",
  USER: "User",
  ORDER: "Order",
} as const;
