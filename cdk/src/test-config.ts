import { defineAuditConfig } from "@flipboxlabs/aws-audit-sdk";

/**
 * Test configuration for CDK tests.
 * Provides sample apps and resource types for testing.
 */
export const testConfig = defineAuditConfig({
  apps: ["App1", "TestApp"] as const,
  resourceTypes: ["Unknown", "User", "Order"] as const,
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
