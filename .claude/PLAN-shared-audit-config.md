# Plan: Share AuditConfig between SDK and CDK

## Goal
Allow users to define their `AuditConfig` once using `defineAuditConfig` from `@nateiler/aws-audit-sdk/config` and pass it to CDK constructs. Constructs create an inline Lambda layer containing the config.

## Approach
1. Add `audit` property to `CDKConfig`
2. `ESMNodeFunctionFactory` creates an inline Lambda layer with the config
3. Handlers import from the layer path `/opt/nodejs/audit-config.js`

## Implementation

### Step 1: CDKConfig stays the same
**File:** `cdk/src/constants.ts`

No changes needed - `CDKConfig` keeps `env`, `aws`, `service` for runtime env vars.
The layer only receives `apps` and `resourceTypes` via the `AuditConfigLayer` constructor.

### Step 2: Create AuditConfigLayer construct
**File:** `cdk/lib/audit-config-layer.ts` (new)

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuditConfig } from "@nateiler/aws-audit-sdk";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export class AuditConfigLayer extends Construct {
  public readonly layer: lambda.LayerVersion;

  constructor(scope: Construct, id: string, config: AuditConfig) {
    super(scope, id);

    // Generate config file content
    const configCode = `
import { defineAuditConfig } from "@nateiler/aws-audit-sdk/config";

export const auditConfig = defineAuditConfig({
  apps: ${JSON.stringify(config.apps)},
  resourceTypes: ${JSON.stringify(config.resourceTypes)},
});

export const App = auditConfig._types.App;
export const ResourceType = auditConfig._types.ResourceType;
`;

    // Create temp directory with proper layer structure
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-config-"));
    const nodejsDir = path.join(tempDir, "nodejs");
    fs.mkdirSync(nodejsDir);
    fs.writeFileSync(path.join(nodejsDir, "audit-config.js"), configCode);

    this.layer = new lambda.LayerVersion(this, "Layer", {
      code: lambda.Code.fromAsset(tempDir),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: "Audit configuration layer",
    });
  }
}
```

### Step 3: Update ESMNodeFunctionFactory to accept layer via props
**File:** `cdk/lib/nodejs.function.ts`

Add optional `auditConfigLayer` to props:
```typescript
export const ESMNodeFunctionFactory =
  (config: CDKConfig, auditConfigLayer?: lambda.ILayerVersion) =>
  (scope: Construct, id: string, props: nodejs.NodejsFunctionProps) => {
    const nodejsFunction = new nodejs.NodejsFunction(scope, id, { ... });

    // Add audit config layer if provided
    if (auditConfigLayer) {
      nodejsFunction.addLayers(auditConfigLayer);
    }

    return nodejsFunction;
  };
```

### Step 4: Create layer once in user's stack and pass to constructs
**User creates layer once:**
```typescript
import { AuditConfigLayer } from "@nateiler/aws-audit-cdk/lib";

// Create once per stack
const auditLayer = new AuditConfigLayer(this, "AuditConfigLayer", auditConfig);

// Pass to constructs
new CloudWatchConstruct(this, "CloudWatch", {
  config: cdkConfig,
  auditConfigLayer: auditLayer.layer,
  ...
});
```

### Step 5: Update handlers to import from layer path
**All handler files:**

Change imports from:
```typescript
import { auditConfig } from "../audit-config.js";
```
To:
```typescript
import { auditConfig } from "/opt/nodejs/audit-config.js";
```

### Step 6: Delete cdk/src/audit-config.ts

### Step 7: Update tests
Mock the layer import path in tests.

## Files to Modify
- `cdk/lib/audit-config-layer.ts` - New construct for config layer
- `cdk/lib/nodejs.function.ts` - Accept layer via second param
- `cdk/src/cloudwatch/subscription.handler.ts` - Import from layer
- `cdk/src/rest-api/resources/trace/handler.ts` - Import from layer
- `cdk/src/rest-api/resources/trace/schema.ts` - Import from layer
- `cdk/src/rest-api/resources/app/resources/objects/handler.ts` - Import from layer
- `cdk/src/rest-api/resources/app/resources/objects/schema.ts` - Import from layer
- `cdk/src/rest-api/resources/app/resources/objects/resources/rerun/handler.ts` - Import from layer
- `cdk/src/rest-api/resources/app/resources/objects/resources/rerun/schema.ts` - Import from layer
- Delete: `cdk/src/audit-config.ts`

## User Usage
```typescript
import { defineAuditConfig } from "@nateiler/aws-audit-sdk/config";
import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import { AuditConfigLayer } from "@nateiler/aws-audit-cdk/lib";
import { CloudWatchConstruct } from "@nateiler/aws-audit-cdk/cloudwatch";

// 1. Define audit config (apps & resourceTypes)
const auditConfig = defineAuditConfig({
  apps: ["Orders", "Inventory"] as const,
  resourceTypes: ["Order", "Product"] as const,
});

// 2. Define CDK config (env, aws - for runtime env vars)
const cdkConfig: CDKConfig = {
  env: "prod",
  aws: { account: "123456789", region: "us-east-1" },
};

// 3. Create layer once per stack (only needs apps/resourceTypes)
const auditLayer = new AuditConfigLayer(this, "AuditConfigLayer", auditConfig);

// 4. Pass both config and layer to constructs
new CloudWatchConstruct(this, "CloudWatch", {
  config: cdkConfig,
  auditConfigLayer: auditLayer.layer,
  table,
  eventBus,
});
```

## Note
- Layer is created with proper `nodejs/` directory structure required by Lambda
- Temp directory is created at synth time
- Single shared layer per stack (user creates once, passes to all constructs)
