import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("CDK_VERSION", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("should equal the CDK package.json version", async () => {
    const { CDK_VERSION } = await import("./version.js");

    expect(CDK_VERSION).toBe(PACKAGE_VERSION);
    expect(CDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([
    ["missing", {}],
    ["empty", { version: "" }],
    ["not a string", { version: 1 }],
  ])("should throw when the version is %s", async (_label, pkg) => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ readFileSync: () => JSON.stringify(pkg) }));

    await expect(import("./version.js")).rejects.toThrow(
      "@flipboxlabs/aws-audit-cdk package.json has no version",
    );
  });
});
