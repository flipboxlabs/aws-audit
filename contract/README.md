# Contract

What the audit Lambdas send to AWS and answer over HTTP, as JSON, so the Rust Lambdas (#93) are tested against the behavior the TypeScript implementation had. The TypeScript SDK keeps writing the same table, so the two must agree.

The files have two owners:

- **Generated from TypeScript:** `fixtures/sdk`, `fixtures/layer` and the audit response schemas (`detail`, `items`, `objects`, `status` and `trace`). `sdk/src/contract.test.ts` and `cdk/src/contract.test.ts` generate them from the SDK and the config layer, and compare them on each `pnpm test`. A change there fails the tests until the files are regenerated:

  ```sh
  pnpm contract:update
  ```

  Review the diff before committing it, because it is a change to the contract the Rust code must follow.

- **Owned by the Rust Lambdas:** `fixtures/http`, `fixtures/subscription`, the `*.path` and `*.query` schemas, and `config.response`. They were recorded from the Node handlers, which the Rust Lambdas replaced (#144). To change that behavior, edit the fixture and the Rust code together; the Rust tests replay every fixture. Keep the fixed inputs below, and add a fixture for each new case.

## Layout

```
contract/
  fixtures/sdk/    SDK operations: the AWS calls made and the result returned
  fixtures/http/   REST requests: the AWS calls made and the HTTP response
  fixtures/subscription/  CloudWatch Logs data the subscription Lambda received, and the AWS calls it made
  fixtures/layer/  audit-config.json as the config layer writes it for Rust Lambdas
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

The Lambda receives an API Gateway REST (v1) proxy event built from `request`. `body` is the parsed JSON body, or `null` when there is none.

## Subscription fixtures

```jsonc
{
  "description": "...",
  "logs": {                           // the decoded awslogs.data
    "messageType": "DATA_MESSAGE",    // or CONTROL_MESSAGE, which holds no audits
    "logGroup": "/aws/lambda/orders",
    "logEvents": [{ "id": "...", "timestamp": 1767323045678, "message": "{\"_audit\":{...}}" }]
  },
  "calls": [ ... ]                    // as in the SDK fixtures
}
```

The Lambda receives `{"awslogs": {"data": ...}}`, where `data` is `logs` as gzipped JSON in base64; encode it the same way to replay one. The audit lines come from the SDK's `Audits`, so they're what an app writes. Every fixture makes at most one audit's calls, because the Lambda stores a batch's audits concurrently and their calls can interleave in any order.

## Comparing

- **Compare JSON as values, not text.** Object key order isn't part of the contract. Expression strings (`UpdateExpression`, `KeyConditionExpression`, `FilterExpression`, `ProjectionExpression`) are, so compare them exactly.
- **The Upserted event's `Detail`** is a JSON string. Compare it parsed.
- **A rerun `Detail`** must be the stored string byte for byte. `rerun/sent` stores one with a space and `1.0` to catch any re-serialization.
- **422 bodies** are compared whole. Issue messages are zod's (`Invalid option: expected one of "App1"|"TestApp"`), which the Rust Lambdas reproduce.
- **Error names** (`AuditNotFoundError`, `InvalidNextTokenError`, `PutEventsError`) are the TypeScript classes. Map them to the Rust error they correspond to.
- **Error bodies** are `{statusCode, error, message}`, with the TypeScript error class's name in `error` (`NotFoundError`, `BadRequestError`, `RequestValidationError`, `InternalServerError`). 422s add `details.issues`.
