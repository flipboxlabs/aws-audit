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

`putEventsWithRetry` works like `putEventsOrThrow` but retries first. Entries
EventBridge rejects, and every entry of a chunk whose PutEvents call throws, are
resent after a jittered exponential backoff; accepted entries are not resent. It
makes 3 attempts in total by default (`attempts`), starting from a 100ms delay
(`baseDelay`), and throws a `PutEventsError` describing the final attempt if
entries are still not accepted.

```typescript
const results = await events.putEventsWithRetry(entries, { attempts: 5, baseDelay: 50 });
```

`AuditEventBus.upserted` publishes with `putEventsWithRetry`, extra events
included, so it throws a `PutEventsError` when an event can't be published.
`AuditService.upsertItem` catches that error instead of throwing: the audit is
already stored, and a throw would make callers upsert it again and record an
extra attempt. It logs at critical level with the stable message
`"Audit stored but Upserted event not published"`, the audit's `id`, `app` and
`target` (`type`, `id`), the `failedEntries`, and the `error`. Use that message
for a CloudWatch metric filter or alarm.

## Errors

`AuditService.getItem` throws `AuditNotFoundError` when no audit matches the identifiers. It extends `Error` and carries the `identifiers` that were looked up. Storage failures (DynamoDB errors, records that fail schema parsing) are rethrown as-is, so they can be told apart from a missing audit.

```typescript
import { AuditNotFoundError } from "@flipboxlabs/aws-audit-sdk";

try {
  const audit = await service.getItem({ id, app, resourceType });
} catch (error) {
  if (error instanceof AuditNotFoundError) {
    // the audit does not exist
  }
  throw error;
}
```

`AuditRepository.getItem` resolves `undefined` only when the item does not exist; any other failure rejects.

## Features

- Audit logging with structured data
- EventBridge integration
- DynamoDB storage
- Middy middleware support
- Batch processing utilities

## License

MIT
