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
import { ConfigLayerConstruct } from "@flipboxlabs/aws-audit-cdk/lambda";
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

    // Create audit config layer with your apps, each with its resource types
    const auditConfigLayer = new ConfigLayerConstruct(this, "AuditConfigLayer", {
      apps: { Orders: ["Order", "Customer"], Inventory: ["Product"] },
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

### ConfigLayerConstruct

Creates a Lambda layer containing your audit configuration: each app, with its resource types. This layer is required by all other constructs.

```typescript
import { ConfigLayerConstruct } from "@flipboxlabs/aws-audit-cdk/lambda";

const auditConfigLayer = new ConfigLayerConstruct(this, "AuditConfigLayer", {
  apps: { Orders: ["Order", "Customer"], Inventory: ["Product"] },
});
```

App and resource type names are REST API path segments, so they may hold only letters, digits, `-` and `_`; synth fails on any other name, or on an app without resource types.

Your own Lambdas can attach `auditConfigLayer.layer` and import `apps` (pass it to `defineAuditConfig({ apps })`) from `AUDIT_CONFIG_LAYER_MODULE_PATH` (`/opt/nodejs/audit-config.mjs`); mark that path external when bundling. The earlier `AUDIT_CONFIG_LAYER_PATH` (`/opt/nodejs/audit-config.js`) still works, but relies on the layer's `nodejs/package.json`, which another layer shipping its own `nodejs/package.json` can replace.

### CloudWatchConstruct

CloudWatch log subscription that captures audit logs and stores them in DynamoDB.

The subscription Lambda is a Rust binary (`provided.al2023`, arm64) that ships prebuilt in this package, so deploying it needs no Rust toolchain. It reads the apps and their resource types from the config layer, and refuses an audit whose type isn't one of its app's. Each audit line is stored on its own: lines without an `_audit` are skipped, and an audit that's invalid or can't be stored is logged without failing the rest of the batch.

### DynamoDBConstruct

The audit table, `{ENV}-{service}-Audit-v2`, retained when removed. Each audit is one item, keyed by its tenant, target and id, each escaped so that no two audits share a key whatever their ids hold; a copy of its summary, marked `related: true`, sits in the same partition for each related resource with an id, so it lists under that resource too. Four global secondary indexes on multi-attribute keys serve the listings, each projecting the audit summary: by resource type, by resource, by status and by trace. The status and trace indexes hold audits only, and also project the `scopes` their resource filters match.

`table` grants cover the indexes. Upgrading from 1.x replaces the table; see [Upgrading from 1.x](#upgrading-from-1x).

### EventBridgeConstruct

EventBridge bus for audit events, enabling event-driven architectures.

### RestApiConstruct

REST API for querying audits by resource, status, or trace ID. Every route requires an API key.

| Method | Path                                              | Description                                                      |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------- |
| `GET`  | `/config`                                         | The deployment's apps with their types, statuses and CDK version |
| `GET`  | `/apps/{app}/objects/{type}`                      | Summaries of a resource type's audits, newest first              |
| `GET`  | `/apps/{app}/objects/{type}/{item}`               | Summaries of a resource's audits, newest first                   |
| `GET`  | `/apps/{app}/objects/{type}/{item}/{audit}`       | A single audit                                                   |
| `POST` | `/apps/{app}/objects/{type}/{item}/{audit}/rerun` | Rerun an audit's event                                           |
| `GET`  | `/status/{status}`                                | Summaries of a status's audits, newest first                     |
| `GET`  | `/trace/{trace}`                                  | Summaries of a trace's audits, by stage                          |

Every listing returns audit summaries: `id`, `tenantId`, `status`, `tier`, `operation`, `message`, `target`, `source`, `rerunable`, `trace`, `createdAt` and `updatedAt`. Fetch the single audit for its `context`, `event`, `error` and `attempts`. Listings are newest first; `GET /trace/{trace}` lists by trace stage, then oldest first. An audit's `trace` is the trace it was written with, and is omitted when it has none.

`{type}` must be one of `{app}`'s resource types; another is a `422`. Getting or rerunning a single audit answers `404` when `{audit}` doesn't exist or belongs to a resource other than `{item}`. A rerun sends the audit's recorded event once, with its `detail` exactly as stored, and answers `204`. It answers `400` when the audit isn't rerunable, and `500` when EventBridge doesn't accept the event; the caller can retry. An audit that lists a resource in `resources` also appears in that resource's listing, with the audit's `id` and its target as the `source`; fetch or rerun it under the source: `/apps/{source.app}/objects/{source.type}/{source.id}/{id}`.

Every listing takes `filter[operation]` (an exact operation name) and `filter[tier]` (`1`, `2` or `3`). `GET /status/{status}` and `GET /trace/{trace}` also take `filter[app]` and `filter[resourceType]`, which match an audit's target or any of its additional `resources`. With `filter[app]`, the type must be one of that app's; without it, the type matches under every app that has it; the audit is returned once, with its own target. Filters apply after a page is read, so a filtered page can hold fewer items than `pagination[pageSize]`, or none, while its `nextToken` continues the listing.

Every route runs as a prebuilt Rust binary, like the subscription Lambda. Every route answers errors as `{statusCode, error, message}`, and a `422` lists each invalid input under `details.issues`, with its location as `path` (e.g. `["query", "filter[app]"]`).

`GET /config` reads the config layer only, so its Lambda has no DynamoDB or EventBridge permissions. Its `version` comes from this package's `package.json` at synth time. Deployments from before the route was added answer `GET /config` with a `403` `{"message":"Missing Authentication Token"}` (API Gateway's response for an unknown route), not a `404`.

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

- `aws-cdk-lib` >= 2.226.0
- `constructs` >= 10.3.0

## Upgrading from 1.x

2.0 stores audits in a new table, `{ENV}-{service}-Audit-v2`: the 1.x table's local secondary indexes can't be removed, and its listings couldn't sort by creation time. Upgrade `@flipboxlabs/aws-audit-cdk` and `@flipboxlabs/aws-audit-sdk` together, in every app that uses the SDK, since 2.0 reads and writes only the new table.

The config lists each app's resource types, replacing the separate `apps` and `resourceTypes` lists: `defineAuditConfig({ apps: { Orders: ["Order"] } })`, and the same `apps` for `ConfigLayerConstruct`. Names may hold only letters, digits, `-` and `_`. `GET /config` answers `apps` as that map, without `resourceTypes`.

1. Deploy. The new table is created empty and the Lambdas switch to it; the 1.x table (`{ENV}-{service}-Audit`) is retained, not deleted.
2. Copy the 1.x audits with the SDK's `aws-audit-migrate`, with credentials for the account and region:

   ```bash
   npx -p @flipboxlabs/aws-audit-sdk aws-audit-migrate \
     --from PROD-Orders-Audit --to PROD-Orders-Audit-v2 --dry-run
   npx -p @flipboxlabs/aws-audit-sdk aws-audit-migrate \
     --from PROD-Orders-Audit --to PROD-Orders-Audit-v2
   ```

   It prints a JSON report: audits and related-resource copies written, those already in the new table (left alone), audits retried since the deploy (merged), copies under their audit's own target (left out, as the audit lists there already), and any items that weren't valid audits or copies, with the reason. Copies written before SDK 1.4.2, which kept their audit's target and named their resource only in their key, are written under that resource. An audit id holding a `#` can make such a key read more than one way; the reading whose audit id names an audit is taken, and a key that reads no way, or several ways naming no audit or more than one, is reported to reconcile by hand. Empty strings, which 1.x stored as `NULL`, are empty strings again wherever a `null` isn't valid, such as an `operation` or an event's `detail`. Writes are conditional, and each audit it writes or merges is marked `migrated: true`, so it can be run again.

3. Once the listings look right, delete the 1.x table yourself.

Run the migration soon after deploying: until it finishes, listings hold only the audits written since. A retry of a 1.x audit in that window starts a new audit in the new table; the migration merges the 1.x audit into it, putting the 1.x attempts first, restoring the earlier `createdAt` on the audit and its copies, and filling in the 1.x fields the retries left out, such as the `event` a rerun sends.

## License

MIT
