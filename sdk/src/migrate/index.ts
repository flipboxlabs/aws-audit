import {
  ConditionalCheckFailedException,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDB } from "../constants.js";
import {
  constructIndexAttributes,
  constructPrimaryKey,
  relatedSortKey,
  resourceScopes,
  type UnmarshalledAttributes,
} from "../repository.js";
import { AuditSchema, AuditSummarySchema } from "../schema/audit.js";
import { DateTimeStringSchema, type ResourceReference } from "../schema/common.js";
import { hasResourceId } from "../utils.js";

const { Attributes, Keys } = DynamoDB;

/** Empty strings are written as such, as the SDK writes them */
const MARSHALL_OPTIONS = { removeUndefinedValues: true } as const;

/**
 * The key attributes of the earlier table (`{ENV}-{service}-Audit`), which aren't
 * copied: the v2 item gets its own keys.
 */
const V1_KEYS = [
  "PK",
  "SK",
  "GSI1_SS_PK",
  "GSI1_SS_SK",
  "GSI1_SN_PK",
  "GSI1_SN_SK",
  "GSI2_SS_PK",
  "GSI2_SS_SK",
  "LSI1_S_SK",
  "LSI1_N_SK",
];

/**
 * Options for {@link migrate}.
 */
export type MigrationOptions = {
  /** DynamoDB client for both tables */
  client: DynamoDBClient;
  /** The earlier table, `{ENV}-{service}-Audit` */
  from: string;
  /** The v2 table, `{ENV}-{service}-Audit-v2` (`DynamoDB.Table.Name()`) */
  to: string;
  /** Read and transform only; write nothing */
  dryRun?: boolean;
  /** Writes in flight at once (default 10) */
  concurrency?: number;
  /** Called after each page of the scan, with the report so far */
  onProgress?: (report: MigrationReport) => void;
};

/**
 * What a migration did. Items already in the v2 table (written there since the
 * deploy, or by an earlier run) are left alone and counted as `existing`, except
 * an audit retried since the deploy, which is `merged`.
 */
export type MigrationReport = {
  /** Items read from the earlier table */
  scanned: number;
  /** `merged`: audits retried since the deploy, given their earlier attempts and createdAt */
  audits: { written: number; existing: number; merged: number };
  /** `ownTarget`: copies under their audit's own target, left out as the audit lists there */
  copies: { written: number; existing: number; ownTarget: number };
  /** Audits whose `scopes` gained their related resources, from their copies */
  scopes: { updated: number; missingAudit: number };
  /** Items that aren't valid audits or copies, which weren't copied */
  invalid: { PK: unknown; SK: unknown; reason: string }[];
};

type Key = { PK: string; SK: string };

/** An item to write; a copy names its audit's key in the earlier table */
type Write = { kind: "audits" | "copies"; item: UnmarshalledAttributes; audit?: Key };

/**
 * Copies every audit of the earlier table into the v2 table.
 *
 * - An audit (`SK` its id) is written under its v2 key with its index
 *   attributes, keeping its fields, `createdAt` and `ttl`. A trace the earlier
 *   table kept only in its index keys is rebuilt from them.
 * - A related resource's copy (`SK` `{auditId}#{app}.{type}#{id}`, its target) is
 *   written as a summary copy in its audit's partition, marked `related`, with its
 *   audit's `createdAt` so it sorts with the audit (the earlier table gave a copy
 *   the time of the audit's latest upsert). Its resource is added to the audit's
 *   `scopes`, so status and trace filters match it. A copy under the audit's own
 *   target is left out, as the audit lists there already.
 *
 * `createdAt` and `updatedAt` are written with milliseconds, as the SDK writes
 * them: the earlier table kept a caller's text, and listings compare them as text.
 * The earlier SDK wrote empty strings as NULL: top-level ones are left out, and
 * nested ones are empty strings again where a null isn't valid (see
 * {@link withEmptyStrings}).
 *
 * Writes are conditional, so a run can be repeated and never replaces what the
 * new version has written since the deploy. Deploy first, then migrate. An audit
 * retried since the deploy has a v2 audit of its own: the earlier attempts are
 * put before its attempts, renumbered, and it and its copies take the earlier
 * `createdAt`. Each audit written or merged is marked `migrated`
 * (`DynamoDB.Attributes.MIGRATED`), which is how a later run knows to leave it.
 *
 * @returns What was copied, skipped and refused
 * @throws {RangeError} When `concurrency` isn't a positive integer
 */
export async function migrate(options: MigrationOptions): Promise<MigrationReport> {
  const { client, from, to, dryRun = false, concurrency = 10, onProgress } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, not ${concurrency}`);
  }
  const report: MigrationReport = {
    scanned: 0,
    audits: { written: 0, existing: 0, merged: 0 },
    copies: { written: 0, existing: 0, ownTarget: 0 },
    scopes: { updated: 0, missingAudit: 0 },
    invalid: [],
  };

  // Related resources' scopes per audit partition, added once every audit is written
  const relatedScopes = new Map<string, Set<string>>();

  const put = async ({ kind, item, audit }: Write, createdAt: CreatedAt) => {
    if (audit) {
      item.createdAt = (await createdAt(audit)) ?? item.createdAt;
    }
    if (dryRun) {
      report[kind].written++;
      return;
    }

    try {
      await client.send(
        new PutItemCommand({
          TableName: to,
          Item: marshall(item, MARSHALL_OPTIONS),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": Keys.PARTITION_KEY },
        }),
      );
      report[kind].written++;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      if (kind === "audits" && (await mergeAudit(client, to, item))) {
        report.audits.merged++;
      } else {
        report[kind].existing++;
      }
    }
  };

  let startKey: Record<string, unknown> | undefined;
  do {
    const { Items: items = [], LastEvaluatedKey: lastKey } = await client.send(
      new ScanCommand({ TableName: from, ExclusiveStartKey: startKey as never }),
    );

    const writes: Write[] = [];
    for (const raw of items) {
      report.scanned++;
      const item = unmarshall(raw);
      const auditId = copyAuditId(item);
      const result = auditId === undefined ? toAudit(item) : toCopy(item, auditId);

      if ("reason" in result) {
        report.invalid.push({ PK: item.PK, SK: item.SK, reason: result.reason });
        continue;
      }
      if ("ownTarget" in result) {
        report.copies.ownTarget++;
        continue;
      }

      writes.push(result.write);
      if (result.scopes) {
        const scopes = relatedScopes.get(result.scopes.partition) ?? new Set();
        result.scopes.values.forEach((scope) => scopes.add(scope));
        relatedScopes.set(result.scopes.partition, scopes);
      }
    }

    // Per page, as copies of an audit are spread across the earlier table
    const createdAt = auditCreatedAt(client, from);
    await inBatches(writes, concurrency, (write) => put(write, createdAt));
    startKey = lastKey;
    onProgress?.(report);
  } while (startKey);

  await inBatches([...relatedScopes], concurrency, async ([partition, scopes]) => {
    if (dryRun) {
      report.scopes.updated++;
      return;
    }

    try {
      await client.send(
        new UpdateItemCommand({
          TableName: to,
          Key: marshall({
            [Keys.PARTITION_KEY]: partition,
            [Keys.SORT_KEY]: DynamoDB.SortKeys.AUDIT,
          }),
          UpdateExpression: "ADD #scopes :scopes",
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#scopes": Attributes.SCOPES, "#pk": Keys.PARTITION_KEY },
          ExpressionAttributeValues: marshall({ ":scopes": scopes }),
        }),
      );
      report.scopes.updated++;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      report.scopes.missingAudit++;
    }
  });

  return report;
}

type Transformed =
  | { write: Write; scopes?: { partition: string; values: string[] } }
  | { reason: string }
  | { ownTarget: true };

/** Reads an earlier audit's `createdAt`, once per audit */
type CreatedAt = (audit: Key) => Promise<string | undefined>;

function auditCreatedAt(client: DynamoDBClient, table: string): CreatedAt {
  const read = new Map<string, Promise<string | undefined>>();

  return (audit) => {
    const name = JSON.stringify([audit.PK, audit.SK]);
    let createdAt = read.get(name);
    if (!createdAt) {
      createdAt = client
        .send(
          new GetItemCommand({
            TableName: table,
            Key: marshall(audit),
            ProjectionExpression: "#createdAt",
            ExpressionAttributeNames: { "#createdAt": "createdAt" },
          }),
        )
        .then(
          ({ Item }) => DateTimeStringSchema.safeParse(Item && unmarshall(Item).createdAt).data,
        );
      read.set(name, createdAt);
    }
    return createdAt;
  };
}

/**
 * The audit id of an earlier related resource's copy, whose `SK` is
 * `{auditId}#{app}.{type}#{id}` for its target; undefined for an audit, whose `SK`
 * is its id, which may hold a `#` too, even ending as a copy's would. An audit has
 * attempts (the earlier SDK appended one on each upsert) and a copy has none, so
 * only an item without attempts is read as a copy.
 */
function copyAuditId(item: UnmarshalledAttributes): string | undefined {
  if (Array.isArray(item.attempts) && item.attempts.length > 0) return undefined;

  const sortKey = String(item.SK ?? "");
  const target = item.target as Partial<ResourceReference> | undefined;
  if (!target?.app || !target.type || !hasResourceId(target.id)) return undefined;

  const suffix = `#${target.app}.${target.type}#${target.id}`;
  return sortKey.length > suffix.length && sortKey.endsWith(suffix)
    ? sortKey.slice(0, -suffix.length)
    : undefined;
}

/**
 * An earlier audit as a v2 audit.
 */
function toAudit(item: UnmarshalledAttributes): Transformed {
  const fields = withTrace(item);
  const id = fields.id ?? item.SK;
  const createdAt = fields.createdAt ?? fields.updatedAt;
  if (typeof createdAt !== "string") {
    // Every index sorts by it; without one the audit would list nowhere
    return { reason: "An audit needs a createdAt or updatedAt" };
  }

  const parsed = AuditSchema.safeParse({ ...fields, id, createdAt });
  if (!parsed.success) {
    return { reason: parsed.error.issues.map((issue) => issue.message).join("; ") };
  }

  const { tenantId, target, trace } = fields as {
    tenantId?: string;
    target: ResourceReference;
    trace?: string;
  };

  return {
    write: {
      kind: "audits",
      item: {
        ...fields,
        id: String(id),
        createdAt: parsed.data.createdAt.toISOString(),
        updatedAt: parsed.data.updatedAt.toISOString(),
        // Index key attributes: defaulted when the earlier item left them out
        status: parsed.data.status,
        tier: parsed.data.tier,
        ...constructPrimaryKey({ tenantId, app: target.app, resourceType: target.type, id }),
        ...constructIndexAttributes({ tenantId, target, trace }, DynamoDB.Kinds.AUDIT),
        [Attributes.SCOPES]: new Set(resourceScopes(target)),
        [Attributes.MIGRATED]: true,
      },
    },
  };
}

/**
 * An earlier related resource's copy as a v2 summary copy, and the scopes it adds
 * to its audit.
 */
function toCopy(item: UnmarshalledAttributes, auditId: string): Transformed {
  const target = item.target as ResourceReference;
  const source = item.source as ResourceReference | undefined;

  if (!source?.app || !source.type) {
    return { reason: "A related resource's copy needs a source" };
  }
  if (hasResourceId(source.id) && relatedSortKey(source) === relatedSortKey(target)) {
    return { ownTarget: true };
  }

  const fields = withTrace(item);
  const createdAt = fields.createdAt ?? fields.updatedAt;
  if (typeof createdAt !== "string") {
    return { reason: "A related resource's copy needs a createdAt or updatedAt" };
  }

  const summary = AuditSummarySchema.safeParse({ ...fields, id: auditId, createdAt });
  if (!summary.success) {
    return { reason: summary.error.issues.map((issue) => issue.message).join("; ") };
  }

  const tenantId = fields.tenantId as string | undefined;
  const { PK: partition } = constructPrimaryKey({
    tenantId,
    app: source.app,
    resourceType: source.type,
    id: auditId,
  });
  const copy = Object.fromEntries(
    DynamoDB.Projections.SUMMARY.filter((name) => fields[name] !== undefined).map((name) => [
      name,
      fields[name],
    ]),
  );

  return {
    write: {
      kind: "copies",
      // The earlier table's key of the audit
      audit: {
        PK: tenantId ? `${tenantId}#${source.app}.${source.type}` : `${source.app}.${source.type}`,
        SK: auditId,
      },
      item: {
        ...copy,
        id: auditId,
        createdAt: summary.data.createdAt,
        updatedAt: summary.data.updatedAt,
        status: summary.data.status,
        tier: summary.data.tier,
        rerunable: fields.rerunable ?? false,
        related: true,
        [Keys.PARTITION_KEY]: partition,
        [Keys.SORT_KEY]: relatedSortKey(target),
        ...constructIndexAttributes({ tenantId, target }, DynamoDB.Kinds.RELATED),
        ...(item.ttl === undefined ? {} : { ttl: item.ttl }),
      },
    },
    scopes: { partition, values: resourceScopes(target) },
  };
}

/**
 * An earlier item's fields without its keys or the attributes stored as NULL (empty
 * strings), with its trace as a string: one the item kept only in its trace index
 * keys is rebuilt from them (`{id}` at stage 0, else `{id}:{stage}`).
 */
function withTrace(item: UnmarshalledAttributes): UnmarshalledAttributes {
  const fields = withEmptyStrings(
    Object.fromEntries(
      Object.entries(item).filter(([name, value]) => !V1_KEYS.includes(name) && value !== null),
    ),
  );
  if (typeof fields.trace === "string") return fields;

  if (typeof item.GSI1_SN_PK !== "string" || item.GSI1_SN_SK === undefined) return fields;

  const prefix = item.tenantId ? `${item.tenantId}#` : undefined;
  const id =
    prefix && item.GSI1_SN_PK.startsWith(prefix)
      ? item.GSI1_SN_PK.slice(prefix.length)
      : item.GSI1_SN_PK;
  const stage = Number(item.GSI1_SN_SK);

  return { ...fields, trace: stage === 0 ? id : `${id}:${stage}` };
}

/**
 * An earlier item's fields with the empty strings the earlier SDK wrote as NULL
 * (`convertEmptyValues`) back where a null isn't valid, so the v2 item is read as
 * the audit was written: in `context`, as a target's, source's or resource's id,
 * and as an attempt's error. A null elsewhere (in `event` or an `error` object)
 * may be one, so it's kept.
 */
function withEmptyStrings(fields: UnmarshalledAttributes): UnmarshalledAttributes {
  const context = (value: unknown): unknown =>
    value === null
      ? ""
      : isRecord(value)
        ? Object.fromEntries(Object.entries(value).map(([name, v]) => [name, context(v)]))
        : value;
  const reference = (value: unknown) =>
    isRecord(value) && value.id === null ? { ...value, id: "" } : value;
  const attempt = (value: unknown) =>
    isRecord(value) && value.error === null ? { ...value, error: "" } : value;

  return {
    ...fields,
    ...(isRecord(fields.context) ? { context: context(fields.context) } : {}),
    ...(isRecord(fields.target) ? { target: reference(fields.target) } : {}),
    ...(isRecord(fields.source) ? { source: reference(fields.source) } : {}),
    ...(Array.isArray(fields.resources) ? { resources: fields.resources.map(reference) } : {}),
    ...(Array.isArray(fields.attempts) ? { attempts: fields.attempts.map(attempt) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads of an audit a merge makes when an upsert changes it meanwhile */
const MERGE_ATTEMPTS = 5;

/**
 * Merges an earlier audit into the v2 audit an upsert wrote since the deploy: its
 * attempts go first, every attempt is renumbered by its position, the audit and
 * its copies take the earlier of the two `createdAt`s, and the audit is marked
 * `migrated`.
 *
 * @returns False when the v2 audit is marked `migrated` already, by an earlier run
 * @throws Error when upserts kept changing the audit while merging
 */
async function mergeAudit(
  client: DynamoDBClient,
  table: string,
  audit: UnmarshalledAttributes,
): Promise<boolean> {
  const key = marshall({ [Keys.PARTITION_KEY]: audit.PK, [Keys.SORT_KEY]: audit.SK });
  const names = {
    "#attempts": "attempts",
    "#createdAt": "createdAt",
    "#migrated": Attributes.MIGRATED,
  };

  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
    const { Item } = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: key,
        ConsistentRead: true,
        ProjectionExpression: "#attempts, #createdAt, #migrated",
        ExpressionAttributeNames: names,
      }),
    );
    const current = Item ? unmarshall(Item) : undefined;
    if (!current || current[Attributes.MIGRATED]) {
      return false;
    }

    // A retry may have given the upsert the earlier createdAt, so it's no sign of a merge
    const createdAt =
      Date.parse(audit.createdAt) < Date.parse(current.createdAt)
        ? audit.createdAt
        : current.createdAt;
    const attempts: UnmarshalledAttributes[] = [
      ...(audit.attempts ?? []),
      ...(current.attempts ?? []),
    ];
    // First too: an interrupted run merges again, finding the audit unmerged
    await moveCopies(client, table, audit.PK, createdAt);
    try {
      await client.send(
        new UpdateItemCommand({
          TableName: table,
          Key: key,
          UpdateExpression:
            "SET #attempts = :attempts, #createdAt = :createdAt, #migrated = :migrated",
          // Unmerged and unchanged since the read: an upsert in between appended an attempt
          ConditionExpression:
            "attribute_not_exists(#migrated) AND #createdAt = :current AND size(#attempts) = :count",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(
            {
              ":attempts": attempts.map((item, i) => ({ ...item, number: i + 1 })),
              ":createdAt": createdAt,
              ":migrated": true,
              ":current": current.createdAt,
              ":count": current.attempts?.length ?? 0,
            },
            MARSHALL_OPTIONS,
          ),
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      continue;
    }

    // Again, as an upsert in between rewrote its copies with the audit's createdAt
    await moveCopies(client, table, audit.PK, createdAt);
    return true;
  }

  throw new Error(`Audit ${audit.PK} changed on each of ${MERGE_ATTEMPTS} merges; run again`);
}

/** Gives the copies in an audit's partition the audit's `createdAt`. */
async function moveCopies(
  client: DynamoDBClient,
  table: string,
  partition: string,
  createdAt: string,
) {
  const names = { "#pk": Keys.PARTITION_KEY, "#sk": Keys.SORT_KEY, "#createdAt": "createdAt" };
  let startKey: QueryCommandOutput["LastEvaluatedKey"];

  do {
    const { Items: copies = [], LastEvaluatedKey: lastKey } = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :related)",
        FilterExpression: "#createdAt <> :createdAt",
        ProjectionExpression: "#pk, #sk",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall({
          ":pk": partition,
          ":related": DynamoDB.SortKeys.RELATED_PREFIX,
          ":createdAt": createdAt,
        }),
        ExclusiveStartKey: startKey,
      }),
    );

    await Promise.all(
      copies.map(async (copy) => {
        try {
          await client.send(
            new UpdateItemCommand({
              TableName: table,
              Key: copy,
              UpdateExpression: "SET #createdAt = :createdAt",
              // Not recreated when it expired meanwhile
              ConditionExpression: "attribute_exists(#pk)",
              ExpressionAttributeNames: { "#pk": Keys.PARTITION_KEY, "#createdAt": "createdAt" },
              ExpressionAttributeValues: marshall({ ":createdAt": createdAt }),
            }),
          );
        } catch (error) {
          if (!(error instanceof ConditionalCheckFailedException)) throw error;
        }
      }),
    );
    startKey = lastKey;
  } while (startKey);
}

/** Runs `fn` over `items`, `size` at a time. */
async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}
