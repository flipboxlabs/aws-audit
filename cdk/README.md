# @flipboxlabs/aws-audit-cdk

AWS Audit CDK - CDK constructs for AWS audit infrastructure

## Installation

```bash
npm install @flipboxlabs/aws-audit-cdk
# or
pnpm add @flipboxlabs/aws-audit-cdk
```

## Usage

```typescript
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import { AuditConfigLayer } from "@flipboxlabs/aws-audit-cdk/lambda";
import { CloudWatchConstruct as CloudWatch } from "@flipboxlabs/aws-audit-cdk/cloudwatch";
import { DynamoDBConstruct as DynamoDB } from "@flipboxlabs/aws-audit-cdk/dynamodb";
import { EventBridgeConstruct as EventBridge } from "@flipboxlabs/aws-audit-cdk/eventbridge";
import { RestApiConstruct as RestAPI } from "@flipboxlabs/aws-audit-cdk/rest-api";

interface Props {
  config: CDKConfig;
}

export class AuditStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, { description: "Audit" });

    // Create audit config layer with your apps and resource types
    const auditConfigLayer = new AuditConfigLayer(this, "AuditConfigLayer", {
      apps: ["Orders", "Inventory"],
      resourceTypes: ["Order", "Product"],
    });

    // DynamoDB (storage)
    const { table } = new DynamoDB(this, "DynamoDB", { config: props.config });

    // EventBridge (events)
    const { eventBus } = new EventBridge(this, "EventBridge", {
      config: props.config,
    });

    // CloudWatch (logging subscription)
    new CloudWatch(this, "CloudWatch", {
      config: props.config,
      lambda: { layers: [auditConfigLayer.layer] },
      table,
      eventBus,
    });

    // REST API (optional)
    new RestAPI(this, "RestAPI", {
      config: props.config,
      lambda: { layers: [auditConfigLayer.layer] },
      table,
      eventBus,
    });
  }
}
```

## Constructs

### AuditConfigLayer

Creates a Lambda layer containing your audit configuration (apps and resource types). This layer is required by all other constructs.

```typescript
import { AuditConfigLayer } from "@flipboxlabs/aws-audit-cdk/lambda";

const auditConfigLayer = new AuditConfigLayer(this, "AuditConfigLayer", {
  apps: ["Orders", "Inventory"],
  resourceTypes: ["Order", "Product"],
});
```

### CloudWatchConstruct

CloudWatch log subscription that captures audit logs and stores them in DynamoDB.

### DynamoDBConstruct

DynamoDB table for audit storage with optimized indexes for querying by app, resource, and trace.

### EventBridgeConstruct

EventBridge bus for audit events, enabling event-driven architectures.

### RestApiConstruct

REST API for querying audits by resource, status, or trace ID. Every route requires an API key.

| Method | Path                                              | Description                                                     |
| ------ | ------------------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/config`                                         | The deployment's apps, resource types, statuses and CDK version |
| `GET`  | `/apps/{app}/objects/{type}`                      | Audits for a resource type                                      |
| `GET`  | `/apps/{app}/objects/{type}/{item}`               | Audits for a resource                                           |
| `GET`  | `/apps/{app}/objects/{type}/{item}/{audit}`       | A single audit                                                  |
| `POST` | `/apps/{app}/objects/{type}/{item}/{audit}/rerun` | Rerun an audit's event                                          |
| `GET`  | `/status/{status}`                                | Audits by status                                                |
| `GET`  | `/trace/{trace}`                                  | Audits by trace ID                                              |

An audit's `trace` is the trace it was written with, and is omitted when it has none. A trace written with stage `0` (`abc:0`) is returned as `abc`, which is equivalent. `GET /status/{status}` omits `trace`, because the status index doesn't project it; fetch the single audit to read it.

`GET /config` reads the `AuditConfigLayer` only, so its Lambda has no DynamoDB or EventBridge permissions. Its `version` comes from this package's `package.json` at synth time. Deployments from before the route was added answer `GET /config` with a `403` `{"message":"Missing Authentication Token"}` (API Gateway's response for an unknown route), not a `404`.

> **Upgrading:** `RestApiConstruct` always adds a `/config` resource at the API root. If your stack already adds its own `config` resource to `restApi.root`, synth fails after upgrading, with a duplicate construct or path error. Rename or remove your route before upgrading.

## CDKConfig

The `CDKConfig` type defines the configuration passed to constructs:

```typescript
type CDKConfig = {
  env: string; // Environment name (e.g., "prod", "staging")
  aws: {
    account: string; // AWS account ID
    region: string; // AWS region
  };
  service?: string; // Optional service name
};
```

## Peer Dependencies

- `aws-cdk-lib` >= 2.135.0
- `constructs` >= 10.3.0

## License

MIT
