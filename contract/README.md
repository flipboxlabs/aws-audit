# Contract

What the TypeScript implementation sends to AWS and answers over HTTP, recorded as JSON so the Rust port (#93) can be tested against the same behavior. The TypeScript SDK keeps writing the same table, so the two must agree.

Nothing here is written by hand. `sdk/src/contract.test.ts` and `cdk/src/contract.test.ts` generate every file and compare them on each `pnpm test`. A change in behavior fails the tests until the files are regenerated:

```sh
pnpm contract:update
```

Review the diff before committing it, because it is a change to the contract the Rust code must follow.

## Layout

```
contract/
  fixtures/sdk/    SDK operations: the AWS calls made and the result returned
  fixtures/http/   REST requests: the AWS calls made and the HTTP response
  schemas/         JSON Schema 2020-12 for each route's path, query and response
```

## Fixed inputs

Every fixture is generated with the same environment, so the requests are deterministic:

| Input                    | Value                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Apps                     | `App1`, `TestApp`                                                                             |
| Resource types           | `Unknown`, `User`, `Order`                                                                    |
| `ENVIRONMENT`, `SERVICE` | `test`, `Contract`, so the table and event bus are both `TEST-Contract-Audit`                 |
| Clock                    | `2026-01-02T03:04:05.678Z`, for `createdAt`, `updatedAt`, attempt `at`, `LSI1_N_SK` and `ttl` |
| Retry jitter             | `Math.random()` is `0.5`                                                                      |
| Audit ids                | Always given in the input. Generated ids are KSUIDs, which no fixture covers.                 |
| `AWS_AUDIT_CDK_VERSION`  | `0.0.0-contract`                                                                              |

## SDK fixtures

```jsonc
{
  "description": "...",
  "operation": "upsertItem",          // AuditService method
  "args": [ ... ],                    // its arguments
  "calls": [                          // every AWS call, in order
    {
      "service": "DynamoDB",          // or "EventBridge"
      "command": "UpdateItem",        // the API action
      "input": { ... },               // the request, with AttributeValues marshalled
      "output": { ... }               // the response fed back (or "error": {name, message} when it threw)
    }
  ],
  "result": { ... }                   // what the method returned (null for void)
  // or "error": { "name": "AuditNotFoundError", "message": "..." }
}
```

To replay one: answer each call with its `output` (or throw its `error`) in order, assert each request equals `input`, then assert the result or error.

Responses to index queries hold only what the index projects: the table keys, the index's keys and `DynamoDB.Projections.LISTING`.

## HTTP fixtures

```jsonc
{
  "description": "...",
  "route": "GET /status/{status}",    // API Gateway resource the request is routed by
  "request": { "method": "GET", "path": "/status/fail", "query": { "filter[app]": "App1" } },
  "calls": [ ... ],                   // as in the SDK fixtures
  "response": { "statusCode": 200, "contentType": "application/json", "body": { ... } }
}
```

The handlers received an API Gateway REST (v1) proxy event built from `request`. `body` is the parsed JSON body, or `null` when there is none.

## Comparing

- **Compare JSON as values, not text.** Object key order isn't part of the contract. Expression strings (`UpdateExpression`, `KeyConditionExpression`, `FilterExpression`, `ProjectionExpression`) are, so compare them exactly.
- **The Upserted event's `Detail`** is a JSON string. Compare it parsed.
- **A rerun `Detail`** must be the stored string byte for byte. `rerun/sent` stores one with a space and `1.0` to catch any re-serialization.
- **422 bodies:** `statusCode`, `error`, `message` and each issue's `path` are the contract. Issue `message` text comes from zod and may differ.
- **Error names** (`AuditNotFoundError`, `InvalidNextTokenError`, `PutEventsError`) are the TypeScript classes. Map them to the Rust error they correspond to.
- **Error bodies** are `{statusCode, error, message}`, with the error's class name in `error` (`NotFoundError`, `BadRequestError`, `RequestValidationError`, `InternalServerError`). 422s add `details.issues`.
