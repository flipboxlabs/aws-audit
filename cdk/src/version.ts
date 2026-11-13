import { readFileSync } from "node:fs";

/**
 * The `@flipboxlabs/aws-audit-cdk` package version, read at synth time.
 *
 * Resolves `package.json` relative to this module, which is one level below the
 * package root in both `src` and `dist`.
 *
 * @internal
 */
export const CDK_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
