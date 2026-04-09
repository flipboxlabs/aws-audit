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

```bash
# List audits for a resource
GET /app/{app}/{resourceType}/{resourceId}

# List audits by trace ID
GET /trace/{traceId}
```

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
