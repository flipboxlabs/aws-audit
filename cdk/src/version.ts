import { readFileSync } from "node:fs";

/**
 * Read the `@flipboxlabs/aws-audit-cdk` package version.
 *
 * Resolves `package.json` relative to this module, which is one level below the
 * package root in both `src` and `dist`. Throws when the version is missing, so a
 * deployment fails at synth rather than serving an unversioned `GET /config`.
 */
const readVersion = (): string => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  if (typeof version !== "string" || version.length === 0) {
    throw new Error("@flipboxlabs/aws-audit-cdk package.json has no version");
  }

  return version;
};

/**
 * The `@flipboxlabs/aws-audit-cdk` package version, read at synth time.
 *
 * @internal
 */
export const CDK_VERSION: string = readVersion();
