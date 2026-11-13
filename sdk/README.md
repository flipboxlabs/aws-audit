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

### Publishing events

`BatchHandler` sends EventBridge entries in batches of 10. `putEvents` never
throws: it logs a failed call and returns `[]`, and it returns rejected entries
(those with an `ErrorCode`) alongside accepted ones.

When the caller must know the events were sent, use `putEventsOrThrow`. It
throws a `PutEventsError` if the PutEvents call fails (the client error is the
`cause`) or EventBridge doesn't accept every entry (the rejected result entries
are in `failedEntries`).

```typescript
import { BatchHandler, PutEventsError } from "@flipboxlabs/aws-audit-sdk";

const events = new BatchHandler(logger, new EventBridgeClient());

try {
  await events.putEventsOrThrow(entries);
} catch (error) {
  if (error instanceof PutEventsError) {
    logger.error("Events not sent", error);
  }
  throw error;
}
```

## Features

- Audit logging with structured data
- EventBridge integration
- DynamoDB storage
- Middy middleware support
- Batch processing utilities

## License

MIT
