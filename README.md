# AWS Audit

A comprehensive audit logging and event management system for AWS Lambda and serverless architectures. Capture, store, and query audit trails across microservices with full distributed tracing support.

## Packages

This monorepo contains two packages that work together, and a Rust crate for Rust Lambdas:

| Package                                                             | Description                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`@flipboxlabs/aws-audit-sdk`](./sdk)                               | Core SDK for audit logging, data models, and business logic |
| [`@flipboxlabs/aws-audit-cdk`](./cdk)                               | AWS CDK constructs for deploying audit infrastructure       |
| [`aws-audit`](./cdk/rust/README.md#using-it-in-your-lambdas) (Rust) | Audit logging for Rust Lambdas, from git                    |

## Features

- **Type-Safe Configuration** - Config-driven TypeScript inference with Zod validation
- **Distributed Tracing** - Automatic X-Ray trace ID extraction and trace-based queries
- **Multi-Tenancy Support** - Optional tenant isolation for SaaS applications
- **Retry Tracking** - Automatic tracking of execution attempts with idempotent writes
- **Related Resource Tracking** - Link audits across related resources in a single operation
- **Event-Driven** - EventBridge integration for downstream processing
- **CloudWatch Integration** - Account-level log subscriptions for automatic audit capture
- **Batch Processing** - Support for SQS, Kinesis, and DynamoDB Streams
- **REST API** - Query audits by resource or trace ID with pagination

## Architecture

```
Lambda Function
      │
      ▼
Audits (buffer in memory)
      │
      ▼
CloudWatch Logs (structured JSON)
      │
      ▼
Subscription Filter ("_audit.operation")
      │
      ▼
Subscription Lambda
      │
      ▼
DynamoDB Table ──► EventBridge
```

## Quick Start

### 1. Install packages

```bash
npm install @flipboxlabs/aws-audit-sdk @flipboxlabs/aws-audit-cdk
```

### 2. Define your audit configuration

```typescript
// audit-config.ts
import { defineAuditConfig } from "@flipboxlabs/aws-audit-sdk";

export const auditConfig = defineAuditConfig({
  apps: {
    Orders: ["Order", "Customer"],
    Payments: ["Payment", "Customer"],
  },
});

export type AuditConfig = typeof auditConfig;
```

Each app lists its own resource types: an audit's type must be one of its app's, and naming the app narrows the type in TypeScript. Two apps may share a type's name. App and type names are REST API path segments, so they may hold only letters, digits, `-` and `_`; `defineAuditConfig` and the CDK layer refuse anything else.

### 3. Deploy infrastructure with CDK

```typescript
import { ConfigLayerConstruct } from "@flipboxlabs/aws-audit-cdk/lambda";
import { CloudWatchConstruct } from "@flipboxlabs/aws-audit-cdk/cloudwatch";
import { DynamoDBConstruct } from "@flipboxlabs/aws-audit-cdk/dynamodb";
import { EventBridgeConstruct } from "@flipboxlabs/aws-audit-cdk/eventbridge";

// In your CDK stack, with `config` your CDKConfig
const { layer } = new ConfigLayerConstruct(this, "AuditConfigLayer", {
  apps: auditConfig.apps,
});
const { table } = new DynamoDBConstruct(this, "DynamoDB", { config });
const { eventBus } = new EventBridgeConstruct(this, "EventBridge", { config });
new CloudWatchConstruct(this, "CloudWatch", {
  config,
  lambda: { layers: [layer] },
  table,
  eventBus,
});
```

The Lambdas the constructs deploy are prebuilt Rust binaries shipped in the package, so synth bundles nothing: no esbuild, Docker or Rust toolchain needed. See the [CDK README](cdk/README.md) for every construct, including the REST API.

### 4. Log audits in your Lambda functions

```typescript
import middy from "@middy/core";
import { Audits, Status } from "@flipboxlabs/aws-audit-sdk";
import { logAudits } from "@flipboxlabs/aws-audit-sdk/middleware";
import { auditConfig } from "./audit-config";

const audits = new Audits({ config: auditConfig });

export const handler = middy(async (event: Event) => {
  // Log an audit entry; the app, and the type against the app's, are checked against the config
  audits.addAudit({
    operation: "createOrder",
    target: { app: "Orders", type: "Order", id: "order-123" },
    status: Status.SUCCESS,
  });

  // logAudits writes them when the handler returns or throws
}).use(logAudits(audits));
```

Each audit is one JSON log line, `{"_audit": {...}}`, which the account-level log subscription stores. A Rust Lambda logs the same lines with the [`aws-audit` crate](./cdk/rust/README.md#using-it-in-your-lambdas):

```rust
let mut audits = Audits::new(config.clone());
audits.add(
    LogAudit::new("createOrder", ResourceReference::new("Orders", "Order").with_id("order-123"))
        .with_status(Status::Success),
)?;
// Written when `audits` is dropped at the end of the invocation
```

### 5. Query audits via REST API

Every route requires an API key (`x-api-key` header).

```bash
# Discover the deployment's apps, resource types, statuses and version
GET /config

# List audits for a resource type
GET /apps/{app}/objects/{resourceType}

# List audits for a resource
GET /apps/{app}/objects/{resourceType}/{resourceId}

# Get a single audit
GET /apps/{app}/objects/{resourceType}/{resourceId}/{auditId}

# Rerun an audit's event
POST /apps/{app}/objects/{resourceType}/{resourceId}/{auditId}/rerun

# List audits by status (success, warn, fail, skip)
GET /status/{status}

# List audits by trace ID
GET /trace/{traceId}
```

Every listing returns audit summaries: `id`, `tenantId`, `status`, `tier`, `operation`, `message`, `target`, `source`, `rerunable`, `trace`, `createdAt` and `updatedAt`. Fetch the single audit for its `context`, `event`, `error` and `attempts`. Listings are newest first; `GET /trace/{trace}` lists by trace stage, then oldest first. An audit's `trace` is the trace it was written with, and is omitted when it has none.

Every listing takes `filter[operation]` (an exact operation name) and `filter[tier]` (`1`, `2` or `3`). `GET /status/{status}` and `GET /trace/{trace}` also take `filter[app]` and `filter[resourceType]`, which match an audit's target or any of its additional `resources`. With `filter[app]`, the type must be one of that app's; without it, the type matches under every app that has it; the audit is returned once, with its own target. Filters apply after a page is read, so a filtered page can hold fewer items than `pagination[pageSize]`, or none, while its `nextToken` continues the listing.

Getting or rerunning a single audit answers `404` when `{auditId}` doesn't exist or belongs to a resource other than `{resourceId}`. A rerun answers `400` unless the audit is rerunable. An audit is rerunable when it recorded an EventBridge event that `PutEvents` accepts (with a `source`, a `detail-type` and a `detail` that's a JSON object, and a source not of AWS's own, `aws.*`) and either failed or was logged with `rerunable: true`; logging `rerunable: false` opts a failure out. Audits are stored with the resulting flag, so listings show it; one an earlier release stored without the flag is judged by the same rule when rerun. A retry that succeeds keeps the event an earlier failure recorded, but its flag says it's no longer rerunable; a failure logged without an event or a flag keeps the flag an earlier attempt stored, so an opt-out stays, and an attempt logged with only a flag stores it. A rerun's outcome is an attempt of the audit it reruns, tagged `rerun: true`, so a successful rerun leaves the audit a success, no longer rerunable, and one that fails again leaves it a rerunable failure. The rerun names the audit in its event's `resources` (`aws-audit:rerun:` and the audit's id, tenant, target and operation as JSON), and the SDK's `AuditBatchProcessor` for SQS (`process_batch` in Rust) logs the outcome under the audit's id, with `rerun: true`, when the audit it builds has the same tenant, target and operation. The target's id counts only when the rerun audit's target has one, so a failed create logged before its resource existed matches the rerun that creates it. Other rules the rerun reaches log their own audits, as before; two handlers that log the same operation on the same target can't be told apart, and both log under the audit's id. An audit given its own `id` keeps it. A handler that logs a message's audit itself can match it with `getRerunAuditId(record, audit)`, and log it with that id and `rerun: true`. An event too large for `PutEvents` with the audit named is rerun without it. Only a target that receives the whole event, such as an SQS queue without an input transformer, gets `resources`; the outcome of any other is its own audit, as is that of a handler on an SDK earlier than this. The event goes to the bus it recorded as `event.eventBusName`, which must be one of the REST API's `rerunEventBuses`; or, when it recorded none, to the REST API's `defaultRerunEventBus`, or else the audit event bus. Give `AuditBatchProcessor` the bus its records come from to record it: `new AuditBatchProcessor(EventType.SQS, audits, createAuditItem, { eventBusName: "PROD-v1-Global" })`. An audit that lists a resource in `resources` also appears in that resource's listing, with the audit's `id` and its target as the `source`; fetch or rerun it under the source: `/apps/{source.app}/objects/{source.type}/{source.id}/{id}`.

`GET /config` answers:

```json
{
  "apps": { "Orders": ["Order", "Customer"], "Payments": ["Payment", "Customer"] },
  "statuses": ["success", "warn", "fail", "skip"],
  "version": "2.0.0"
}
```

`version` is the `@flipboxlabs/aws-audit-cdk` version the deployment was built from. Deployments from before `GET /config` was added answer it with API Gateway's response for an unknown route, a `403` `{"message":"Missing Authentication Token"}` rather than a `404`, so treat that as "not supported" and fall back to configured values.

## SDK Package

The SDK provides:

- **AuditService** - High-level CRUD operations for audit records
- **AuditRepository** - Low-level DynamoDB data access
- **AuditEventBus** - EventBridge event publishing
- **Audits** - CloudWatch log-based audit buffering
- **AuditBatchProcessor** - Batch processing for SQS/Kinesis/DynamoDB Streams
- **Middleware** - Middy.js integration for automatic lifecycle management

[View SDK documentation](./sdk/README.md)

## CDK Package

The CDK package provides constructs for:

- **DynamoDBConstruct** - Audit table, with an index per listing (upgrading from 1.x: see [the CDK documentation](./cdk/README.md#upgrading-from-1x))
- **EventBridgeConstruct** - Event bus for audit events
- **CloudWatchConstruct** - Account-level log subscription
- **RestApiConstruct** - API Gateway with audit query endpoints

[View CDK documentation](./cdk/README.md)

## Data Model

Each audit record contains:

| Field          | Description                                   |
| -------------- | --------------------------------------------- |
| `app`          | Application identifier                        |
| `resourceType` | Type of resource being audited                |
| `resourceId`   | Unique identifier for the resource            |
| `operation`    | Action performed (e.g., "created", "updated") |
| `status`       | Result status (SUCCESS, FAIL)                 |
| `tier`         | Log level (INFO, WARN, ERROR)                 |
| `traceId`      | X-Ray trace ID for distributed tracing        |
| `context`      | Additional contextual data                    |
| `tenantId`     | Optional tenant identifier                    |
| `createdAt`    | Timestamp of the audit event                  |

## Requirements

- Node.js >= 20
- AWS CDK v2
- TypeScript 5.x

## License

MIT License - see [LICENSE](./LICENSE) for details.
