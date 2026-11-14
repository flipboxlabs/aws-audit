import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

/**
 * Input configuration for the audit config layer.
 * Contains the apps and resource types that will be available to Lambda handlers.
 */
export interface AuditConfigLayerProps {
  /** List of valid application identifiers */
  readonly apps: readonly string[];
  /** List of valid resource type identifiers */
  readonly resourceTypes: readonly string[];
}

/**
 * Path where handlers should import the audit config from.
 * This is the standard Lambda layer path for Node.js.
 *
 * The `.mjs` extension makes Node load it as an ES module no matter which
 * `package.json` ends up at `/opt/nodejs` once Lambda merges every layer into `/opt`.
 */
export const AUDIT_CONFIG_LAYER_MODULE_PATH = "/opt/nodejs/audit-config.mjs";

/**
 * Earlier path of the audit config, kept for handlers that still import it.
 *
 * It loads as an ES module only through the layer's `nodejs/package.json`
 * (`{"type":"module"}`), which another layer shipping its own
 * `nodejs/package.json` can replace. Prefer {@link AUDIT_CONFIG_LAYER_MODULE_PATH}.
 */
export const AUDIT_CONFIG_LAYER_PATH = "/opt/nodejs/audit-config.js";

/**
 * Path where Rust handlers read the audit config from: the layer's root, which
 * Lambda mounts at `/opt` for every runtime.
 */
export const AUDIT_CONFIG_JSON_PATH = "/opt/audit-config.json";

/**
 * Creates a Lambda layer containing the audit configuration.
 *
 * The layer exports raw `apps` and `resourceTypes` arrays that Node handlers
 * can use with `defineAuditConfig` from the SDK, and writes the same arrays to
 * {@link AUDIT_CONFIG_JSON_PATH} for Rust handlers.
 *
 * @example
 * ```typescript
 * import { ConfigLayerConstruct } from "@flipboxlabs/aws-audit-cdk/lambda";
 *
 * const auditLayer = new ConfigLayerConstruct(this, "AuditConfigLayer", {
 *   apps: ["Orders", "Inventory"],
 *   resourceTypes: ["Order", "Product"],
 * });
 *
 * // Pass auditLayer.layer to constructs that need it
 * ```
 */
export class ConfigLayerConstruct extends Construct {
  public readonly layer: lambda.LayerVersion;

  constructor(scope: Construct, id: string, props: AuditConfigLayerProps) {
    super(scope, id);

    // Generate config file content - exports raw data
    // Handlers will call defineAuditConfig themselves
    const configCode = `// Auto-generated audit configuration
export const apps = ${JSON.stringify(props.apps)};
export const resourceTypes = ${JSON.stringify(props.resourceTypes)};
`;

    // Create temp directory with proper layer structure
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-config-"));
    const nodejsDir = path.join(tempDir, "nodejs");
    fs.mkdirSync(nodejsDir);
    fs.writeFileSync(path.join(nodejsDir, "audit-config.mjs"), configCode);
    // Keep audit-config.js for handlers importing the earlier path; without the
    // package.json Node loads it as CommonJS and they fail at init with
    // "Named export 'apps' not found"
    fs.writeFileSync(path.join(nodejsDir, "audit-config.js"), configCode);
    fs.writeFileSync(path.join(nodejsDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(
      path.join(tempDir, path.basename(AUDIT_CONFIG_JSON_PATH)),
      JSON.stringify({ apps: props.apps, resourceTypes: props.resourceTypes }),
    );

    this.layer = new lambda.LayerVersion(this, "Layer", {
      code: lambda.Code.fromAsset(tempDir),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X, lambda.Runtime.PROVIDED_AL2023],
      description: "Audit configuration layer containing apps and resourceTypes",
    });
  }
}
