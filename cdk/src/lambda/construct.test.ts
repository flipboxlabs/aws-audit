import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as cdk from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { ConfigLayerConstruct } from "./construct.js";

const APPS = ["Orders", "Inventory"];
const RESOURCE_TYPES = ["Order", "Product"];

// Synthesizes the layer and returns its staged asset directory
const synthLayerAsset = (): string => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  new ConfigLayerConstruct(stack, "AuditConfigLayer", {
    apps: APPS,
    resourceTypes: RESOURCE_TYPES,
  });

  const { directory } = app.synth();
  const assets = fs.readdirSync(directory).filter((entry) => entry.startsWith("asset."));

  expect(assets).toHaveLength(1);

  return path.join(directory, assets[0]);
};

describe("ConfigLayerConstruct", () => {
  it("should write the config under nodejs/ as an ES module package", () => {
    const nodejsDir = path.join(synthLayerAsset(), "nodejs");

    expect(fs.readdirSync(nodejsDir).sort()).toEqual(["audit-config.js", "package.json"]);
    expect(JSON.parse(fs.readFileSync(path.join(nodejsDir, "package.json"), "utf8"))).toEqual({
      type: "module",
    });
  });

  it("should load the config as ESM without module syntax detection", () => {
    const configUrl = pathToFileURL(path.join(synthLayerAsset(), "nodejs", "audit-config.js"));

    // Lambda's Node runtime doesn't rely on syntax detection, so disable it here too
    const output = execFileSync(
      process.execPath,
      [
        "--no-experimental-detect-module",
        "--input-type=module",
        "-e",
        `const { apps, resourceTypes } = await import(${JSON.stringify(configUrl.href)});
console.log(JSON.stringify({ apps, resourceTypes }));`,
      ],
      { encoding: "utf8" },
    );

    expect(JSON.parse(output)).toEqual({ apps: APPS, resourceTypes: RESOURCE_TYPES });
  });
});
