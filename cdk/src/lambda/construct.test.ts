import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vite-plus/test";
import { ConfigLayerConstruct } from "./construct.js";

const APPS = { Orders: ["Order", "Customer"], Inventory: ["Product"] };

// Synthesizes the layer and returns its staged directory, which Lambda mounts at /opt
const synthLayerDir = (): string => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  new ConfigLayerConstruct(stack, "AuditConfigLayer", {
    apps: APPS,
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
      `const config = await import(${JSON.stringify(configUrl.href)});
console.log(JSON.stringify({ ...config }));`,
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
    });
  });

  it("should be compatible with the Node.js and provided.al2023 runtimes", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    new ConfigLayerConstruct(stack, "AuditConfigLayer", {
      apps: APPS,
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

    expect(importConfig(path.join(nodejsDir, "audit-config.mjs"))).toEqual({ apps: APPS });
  });

  it("should load audit-config.js as ESM without module syntax detection", () => {
    expect(importConfig(path.join(synthLayerNodejsDir(), "audit-config.js"))).toEqual({
      apps: APPS,
    });
  });

  it.each([
    [{ Orders: [] }, 'App "Orders" must list at least one resource type'],
    [{ "Order Desk": ["Order"] }, 'App "Order Desk" must hold only letters, digits, - and _'],
    [{ Orders: ["Order/Line"] }, 'Resource type "Order/Line" of app "Orders" must hold only'],
    // The 1.x shape, from a JavaScript caller, which the Rust Lambdas can't load
    [["Orders"], "apps must map each app to its resource types"],
    [{ Orders: "Order" }, 'App "Orders" must list its resource types as an array of strings'],
  ])("should refuse %j at synth", (apps, message) => {
    const stack = new cdk.Stack(new cdk.App(), "TestStack");

    expect(
      () => new ConfigLayerConstruct(stack, "AuditConfigLayer", { apps: apps as never }),
    ).toThrow(message);
  });
});
