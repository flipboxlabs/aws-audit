# AWS Audit

A comprehensive audit logging and event management system for AWS Lambda and serverless architectures. Capture, store, and query audit trails across microservices with full distributed tracing support.

## Packages

This monorepo contains two packages that work together:

| Package                               | Description                                                 |
| ------------------------------------- | ----------------------------------------------------------- |
| [`@flipboxlabs/aws-audit-sdk`](./sdk) | Core SDK for audit logging, data models, and business logic |
| [`@flipboxlabs/aws-audit-cdk`](./cdk) | AWS CDK constructs for deploying audit infrastructure       |

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
  apps: ["my-app", "my-other-app"],
  resourceTypes: ["user", "order", "payment"],
});

export type AuditConfig = typeof auditConfig;
```

### 3. Deploy infrastructure with CDK

```typescript
import {
  DynamoDBConstruct,
  EventBridgeConstruct,
  CloudWatchConstruct,
} from "@flipboxlabs/aws-audit-cdk";

// In your CDK stack
new DynamoDBConstruct(this, "AuditTable");
new EventBridgeConstruct(this, "AuditEventBus");
new CloudWatchConstruct(this, "AuditSubscription", {
  handler: subscriptionLambda,
});
```

### 4. Log audits in your Lambda functions

```typescript
import { Audits } from "@flipboxlabs/aws-audit-sdk";
import type { AuditConfig } from "./audit-config";

const audits = new Audits<AuditConfig>();

export const handler = async (event: Event) => {
  // Log an audit entry
  audits.add({
    app: "my-app",
    resourceType: "order",
    resourceId: "order-123",
    operation: "created",
    status: "SUCCESS",
    tier: "INFO",
  });

  // Audits are automatically flushed at Lambda completion
};
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

An audit's `trace` is the trace it was written with, and is omitted when it has none. `GET /apps/{app}/objects/{type}/{item}` and `GET /trace/{trace}` rebuild it from index keys, so there a trace written with stage `0` (`abc:0`) comes back as the equivalent `abc`. `GET /status/{status}` omits `trace`, because the status index doesn't project it; fetch the single audit to read it.

Getting or rerunning a single audit answers `404` when `{auditId}` doesn't exist or belongs to a resource other than `{resourceId}`. An audit's copy for a related resource has the id `{parentId}#{relatedApp}.{relatedType}#{relatedId}` and is found under that resource, `/apps/{relatedApp}/objects/{relatedType}/{relatedId}/{copyId}` (URL-encode the `#`s), not under the original audit's resource.

`GET /config` answers:

```json
{
  "apps": ["Orders", "Inventory"],
  "resourceTypes": ["Order", "Product"],
  "statuses": ["success", "warn", "fail", "skip"],
  "version": "1.6.0"
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

- **DynamoDBConstruct** - Audit table with optimized indexes
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
