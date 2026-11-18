/**
 * Writes `v1.json`: audits upserted by the released 1.x SDKs' own service, into
 * DynamoDB Local, as each table stored them (AttributeValue JSON), for the
 * migration tests. Run it from an empty directory, with DynamoDB Local listening
 * on port 18000:
 *
 *   docker run --rm -p 127.0.0.1:18000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory
 *   npm install @flipboxlabs/aws-audit-sdk@1.4.1 sdk18@npm:@flipboxlabs/aws-audit-sdk@1.8.0
 *   node <repo>/sdk/src/migrate/fixtures/generate.mjs > <repo>/sdk/src/migrate/fixtures/v1.json
 */
import { CreateTableCommand, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { pathToFileURL } from "node:url";

const client = new DynamoDBClient({
  endpoint: "http://127.0.0.1:18000",
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const logger = { debug() {}, info() {}, warn() {}, error: console.error };

async function run(pkg, env, audits) {
  const dist = new URL(`node_modules/${pkg}/dist/`, pathToFileURL(`${process.cwd()}/`));
  const { defineAuditConfig } = await import(new URL("config.js", dist));
  const { AuditRepository } = await import(new URL("repository.js", dist));
  const { AuditService } = await import(new URL("service.js", dist));

  process.env.ENVIRONMENT = env;
  const table = `${env.toUpperCase()}-Audit`;
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    }),
  );

  const config = defineAuditConfig({ apps: ["Jobs", "CRM"], resourceTypes: ["Job", "Contact"] });
  const service = new AuditService(
    logger,
    config,
    new AuditRepository(logger, config, client),
    null,
  );
  for (const audit of audits) await service.upsertItem(audit);

  const { Items } = await client.send(new ScanCommand({ TableName: table }));
  return Items.sort((a, b) => (a.PK.S + a.SK.S).localeCompare(b.PK.S + b.SK.S));
}

const base = { status: "success", tier: 2, operation: "sync", message: "Synced" };
const job = { app: "Jobs", type: "Job", id: "1" };

const v141 = await run("@flipboxlabs/aws-audit-sdk", "v141", [
  // A copy's SK names its resource: job#CRM.Contact#7
  { ...base, id: "job", target: job, resources: [{ app: "CRM", type: "Contact", id: "7" }] },
  // Its copy's SK splits two ways, and only one names an audit: this one
  {
    ...base,
    id: "x#CRM.Contact#7",
    target: job,
    resources: [{ app: "CRM", type: "Contact", id: "8" }],
  },
  // Two audits whose copies share one SK, a#CRM.Contact#7#CRM.Contact#8
  {
    ...base,
    id: "a",
    target: job,
    resources: [{ app: "CRM", type: "Contact", id: "7#CRM.Contact#8" }],
  },
  {
    ...base,
    id: "a#CRM.Contact#7",
    target: job,
    resources: [{ app: "CRM", type: "Contact", id: "8" }],
  },
  // Its copy's SK ends as an own-target copy's would, job#Jobs.Job#7#Jobs.Job#1
  {
    ...base,
    id: "own",
    target: job,
    resources: [{ app: "Jobs", type: "Job", id: "7#Jobs.Job#1" }],
  },
  // Without an id: the writer generates the audit's, but keys its copy undefined#CRM.Contact#9
  {
    ...base,
    target: { app: "Jobs", type: "Job", id: "2" },
    resources: [{ app: "CRM", type: "Contact", id: "9" }],
  },
  // Empty strings, which the writer stores as NULL
  {
    ...base,
    id: "empty",
    target: job,
    operation: "",
    message: "",
    context: { note: "", nested: { value: "" } },
    event: { source: "jobs", "detail-type": "Sync", detail: "" },
  },
]);

const v180 = await run("sdk18", "v180", [
  { ...base, id: "job", target: job, resources: [{ app: "CRM", type: "Contact", id: "7" }] },
  {
    ...base,
    target: { app: "Jobs", type: "Job", id: "2" },
    resources: [{ app: "CRM", type: "Contact", id: "9" }],
  },
]);

console.log(JSON.stringify({ "1.4.1": v141, "1.8.0": v180 }, null, 2));
