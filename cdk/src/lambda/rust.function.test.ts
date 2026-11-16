import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { CDKConfig } from "../constants.js";
import {
  RUST_LAMBDA_ASSETS_DIR,
  RUST_LAMBDA_ASSETS_VARIABLE,
  RustFunctionFactory,
  rustLambdaAsset,
} from "./rust.function.js";

const config: CDKConfig = {
  env: "test",
  aws: { account: "123456789012", region: "us-east-1" },
  service: "Audit",
};

describe("RustFunctionFactory", () => {
  let assets: string;
  // The stubs test-setup.ts points at
  const stubs = process.env[RUST_LAMBDA_ASSETS_VARIABLE];

  beforeEach(() => {
    // A stub binary, so the test needs no Rust build
    assets = fs.mkdtempSync(path.join(os.tmpdir(), "rust-lambda-assets-"));
    fs.mkdirSync(path.join(assets, "subscription"));
    fs.writeFileSync(path.join(assets, "subscription", "bootstrap"), "stub");
    process.env[RUST_LAMBDA_ASSETS_VARIABLE] = assets;
  });

  afterEach(() => {
    if (stubs === undefined) {
      delete process.env[RUST_LAMBDA_ASSETS_VARIABLE];
    } else {
      process.env[RUST_LAMBDA_ASSETS_VARIABLE] = stubs;
    }
    fs.rmSync(assets, { recursive: true, force: true });
  });

  const synth = (props: Partial<Parameters<ReturnType<typeof RustFunctionFactory>>[2]> = {}) => {
    const stack = new cdk.Stack(new cdk.App(), "TestStack", {
      env: { account: config.aws.account, region: config.aws.region },
    });
    RustFunctionFactory(config)(stack, "Subscription", { binary: "subscription", ...props });

    return Template.fromStack(stack);
  };

  it("should run the binary on provided.al2023 with the standard settings", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "provided.al2023",
      Handler: "bootstrap",
      Architectures: ["arm64"],
      MemorySize: 512,
      Timeout: 10,
      TracingConfig: { Mode: "Active" },
      Environment: {
        Variables: {
          ENVIRONMENT: "test",
          AWS_ACCOUNT: "123456789012",
          POWERTOOLS_LOG_LEVEL: "WARN",
          SERVICE: "Audit",
        },
      },
      Layers: ["arn:aws:lambda:us-east-1:580247275435:layer:LambdaInsightsExtension-Arm64:2"],
    });
  });

  it("should keep the standard variables over the caller's", () => {
    synth({ environment: { ENVIRONMENT: "other", EXTRA: "1" } }).hasResourceProperties(
      "AWS::Lambda::Function",
      {
        Environment: {
          Variables: Match.objectLike({ ENVIRONMENT: "test", EXTRA: "1" }),
        },
      },
    );
  });

  it("should let props override the defaults", () => {
    synth({ memorySize: 1024, timeout: cdk.Duration.seconds(30) }).hasResourceProperties(
      "AWS::Lambda::Function",
      { MemorySize: 1024, Timeout: 30 },
    );
  });

  it("should fail at synth when the binary isn't built", () => {
    expect(() => synth({ binary: "missing" })).toThrow(/The missing Lambda isn't built/);
  });

  it("should read binaries from the package's assets by default", () => {
    delete process.env[RUST_LAMBDA_ASSETS_VARIABLE];

    expect(rustLambdaAsset("subscription")).toBe(path.join(RUST_LAMBDA_ASSETS_DIR, "subscription"));
    expect(RUST_LAMBDA_ASSETS_DIR).toBe(path.resolve(import.meta.dirname, "../../assets/lambda"));
  });
});
