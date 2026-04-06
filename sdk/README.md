# @flipboxlabs/aws-audit-sdk

AWS Audit SDK - Core SDK for batch audit logging and event management

## Installation

```bash
npm install @flipboxlabs/aws-audit-sdk
# or
pnpm add @flipboxlabs/aws-audit-sdk
```

## Usage

```typescript
import { Audits, defineAuditConfig } from "@flipboxlabs/aws-audit-sdk";
import { logAudits } from "@flipboxlabs/aws-audit-sdk/middleware";
```

## Features

- Audit logging with structured data
- EventBridge integration
- DynamoDB storage
- Middy middleware support
- Batch processing utilities

## License

MIT
