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
 */
export const AUDIT_CONFIG_LAYER_PATH = "/opt/nodejs/audit-config.js";

/**
 * Creates a Lambda layer containing the audit configuration.
 *
 * The layer exports raw `apps` and `resourceTypes` arrays that handlers
 * can use with `defineAuditConfig` from the SDK.
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
    fs.writeFileSync(path.join(nodejsDir, "audit-config.js"), configCode);

    this.layer = new lambda.LayerVersion(this, "Layer", {
      code: lambda.Code.fromAsset(tempDir),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: "Audit configuration layer containing apps and resourceTypes",
    });
  }
}
