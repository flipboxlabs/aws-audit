import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vite-plus/test";
import { ConfigLayerConstruct } from "./construct.js";

const APPS = ["Orders", "Inventory"];
const RESOURCE_TYPES = ["Order", "Product"];

// Synthesizes the layer and returns its staged directory, which Lambda mounts at /opt
const synthLayerDir = (): string => {
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

// Synthesizes the layer and returns its staged nodejs/ directory
const synthLayerNodejsDir = (): string => path.join(synthLayerDir(), "nodejs");

// Imports a config file in a fresh Node process, as Lambda's runtime would
const importConfig = (file: string): unknown => {
  const configUrl = pathToFileURL(file);

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

  return JSON.parse(output);
};

describe("ConfigLayerConstruct", () => {
  it("should write audit-config.json at the layer root for Rust handlers", () => {
    const layerDir = synthLayerDir();

    expect(fs.readdirSync(layerDir).sort()).toEqual(["audit-config.json", "nodejs"]);
    expect(JSON.parse(fs.readFileSync(path.join(layerDir, "audit-config.json"), "utf8"))).toEqual({
      apps: APPS,
      resourceTypes: RESOURCE_TYPES,
    });
  });

  it("should be compatible with the Node.js and provided.al2023 runtimes", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    new ConfigLayerConstruct(stack, "AuditConfigLayer", {
      apps: APPS,
      resourceTypes: RESOURCE_TYPES,
    });

    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::LayerVersion", {
      CompatibleRuntimes: ["nodejs24.x", "provided.al2023"],
    });
  });

  it("should write the config under nodejs/ as .mjs and as .js in an ES module package", () => {
    const nodejsDir = synthLayerNodejsDir();

    expect(fs.readdirSync(nodejsDir).sort()).toEqual([
      "audit-config.js",
      "audit-config.mjs",
      "package.json",
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(nodejsDir, "package.json"), "utf8"))).toEqual({
      type: "module",
    });
  });

  it("should load audit-config.mjs as ESM without the layer's package.json", () => {
    const nodejsDir = synthLayerNodejsDir();

    // Another layer can replace /opt/nodejs/package.json; the .mjs must not depend on it
    fs.rmSync(path.join(nodejsDir, "package.json"));

    expect(importConfig(path.join(nodejsDir, "audit-config.mjs"))).toEqual({
      apps: APPS,
      resourceTypes: RESOURCE_TYPES,
    });
  });

  it("should load audit-config.js as ESM without module syntax detection", () => {
    expect(importConfig(path.join(synthLayerNodejsDir(), "audit-config.js"))).toEqual({
      apps: APPS,
      resourceTypes: RESOURCE_TYPES,
    });
  });
});
