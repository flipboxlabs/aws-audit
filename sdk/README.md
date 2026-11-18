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

`putEventsWithRetry` works like `putEventsOrThrow` but retries entries
EventBridge rejected for a transient reason (`ThrottlingException`,
`InternalFailure`, `InternalException`, `ServiceUnavailable`). Only those
entries are resent, after a jittered exponential backoff capped at 30 seconds.
It makes 3 attempts in total by default (`attempts`), starting from a 100ms
delay (`baseDelay`). Because PutEvents isn't idempotent, nothing that might
already have been published is resent: a PutEvents call that throws (after the
client's own retries) fails its chunk, an entry with no result entry fails, and
any other `ErrorCode` fails right away. If any entry is not accepted, it throws
a `PutEventsError` with the rejected entries in `failedEntries`, every result
entry returned in `results`, and the last client error as `cause` if a call
threw.

```typescript
const results = await events.putEventsWithRetry(entries, { attempts: 5, baseDelay: 50 });
```

`AuditEventBus.upsertedOrThrow` publishes Upserted events (extra events
included) with `putEventsWithRetry` and throws its `PutEventsError`.
`AuditEventBus.upserted` sends the same way but never throws: it logs at
critical level and returns the result entries, or `[]` if a call threw, like
`putEvents`.

`AuditService.upsertItem` uses `upsertedOrThrow` and catches the error instead
of throwing: the audit is already stored, and a throw would make callers upsert
it again and record an extra attempt. It logs at critical level with the stable
message `"Audit stored but Upserted event not published"`, the audit's
`tenantId`, `id`, `app` and `target` (`type`, `id`), the `failedEntries`, and
the `error`. Use that message for a CloudWatch metric filter or alarm.

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

## Listing

`AuditService` lists audits by resource type (`listObjects`), resource
(`listItems`), status (`listByStatus`) and trace (`listTraceItems`). Each returns
a page of `AuditSummary` (no `context`, `event`, `error` or `attempts`; `getItem`
returns the whole audit), newest first, or by stage then oldest first for a trace.
Each takes `operation` and `tier` filters; the status and trace listings also take
`app` and `resource` (`type`, and `id` together with both), which match an
audit's target or any of its related resources.

The resource and resource type listings also hold a copy of each audit that names
the resource as a related resource. A copy has the audit's id, the resource as
`target`, the audit's target as `source`, and `related: true`: fetch or rerun the
audit by its `source`. A retry keeps the fields it leaves out, and each copy it
writes shows the audit as stored, with them; a retry whose target has no id no
longer lists under the earlier target's resource.

```typescript
const { items, pagination } = await service.listByStatus(
  { status: "fail", app: "Orders", resource: { type: "Order" }, tier: 1 },
  { pageSize: 50 },
);
```

Filters apply after a page is read, so a filtered page can hold fewer items than
its size, or none, while `pagination.nextToken` continues the listing.

The tenant id `-` is reserved: it keys the audits without a tenant. An audit with
it fails validation, and a listing for it throws `ReservedTenantError`. An empty
tenant id is no tenant.

## Migrating from 1.x

2.0 stores audits in a new table, `{ENV}-{service}-Audit-v2`. After deploying
`@flipboxlabs/aws-audit-cdk` 2.0, copy the 1.x audits with the bundled CLI:

```bash
npx -p @flipboxlabs/aws-audit-sdk aws-audit-migrate --from PROD-Orders-Audit --to PROD-Orders-Audit-v2
```

`--dry-run` reads and transforms without writing. The migration is also
available as `migrate` from `@flipboxlabs/aws-audit-sdk/migrate`. See the
[CDK upgrade steps](../cdk/README.md#upgrading-from-1x).

## Features

- Audit logging with structured data
- EventBridge integration
- DynamoDB storage
- Middy middleware support
- Batch processing utilities

## License

MIT
