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

/** An item to write; a copy names its audit's key in the earlier table and in the v2 table */
type Write = {
  kind: "audits" | "copies";
  item: UnmarshalledAttributes;
  audit?: { from: Key; to: Key };
};

/**
 * Copies every audit of the earlier table into the v2 table.
 *
 * - An audit (`SK` its id) is written under its v2 key with its index
 *   attributes, keeping its fields, `createdAt` and `ttl`. A trace the earlier
 *   table kept only in its index keys is rebuilt from them.
 * - A related resource's copy (`SK` `{auditId}#{app}.{type}#{id}`, see
 *   {@link copyOf}) is written as a summary copy in its audit's partition, marked
 *   `related`, with its audit's `createdAt` so it sorts with the audit (the
 *   earlier table gave a copy the time of the audit's latest upsert): the earlier
 *   of the earlier audit's and, when an upsert wrote one since the deploy, the v2
 *   audit's, which is what merging gives the audit. Its resource is added to the
 *   audit's `scopes`, so status and trace filters match it. A copy under the
 *   audit's own target is left out, as the audit lists there already.
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
 * put before its attempts, renumbered, it and its copies take the earlier
 * `createdAt`, and it gets the earlier audit's fields the retries left out (such
 * as the `event` a rerun sends). Each audit written or merged is marked `migrated`
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
      const copy = copyOf(item);
      const result = !copy ? toAudit(item) : "reason" in copy ? copy : toCopy(item, copy);

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
    const createdAt = auditCreatedAt(client, from, to);
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

/**
 * Reads the `createdAt` an audit's copies take, once per audit: the earlier of the
 * earlier audit's and the v2 audit's. A merge gives the audit the earlier of the
 * two, whether it runs before or after, so a copy written on a later page agrees.
 */
type CreatedAt = (audit: { from: Key; to: Key }) => Promise<string | undefined>;

function auditCreatedAt(client: DynamoDBClient, from: string, to: string): CreatedAt {
  const read = new Map<string, Promise<string | undefined>>();
  const createdAt = (table: string, key: Key) =>
    client
      .send(
        new GetItemCommand({
          TableName: table,
          Key: marshall(key),
          // The v2 audit as merged so far
          ConsistentRead: table === to,
          ProjectionExpression: "#createdAt",
          ExpressionAttributeNames: { "#createdAt": "createdAt" },
        }),
      )
      .then(({ Item }) => DateTimeStringSchema.safeParse(Item && unmarshall(Item).createdAt).data);

  return (audit) => {
    const name = JSON.stringify([audit.from.PK, audit.from.SK]);
    let earliest = read.get(name);
    if (!earliest) {
      earliest = Promise.all([createdAt(from, audit.from), createdAt(to, audit.to)]).then(
        (times) =>
          times
            .filter((time) => time !== undefined)
            .sort((a, b) => Date.parse(a) - Date.parse(b))[0],
      );
      read.set(name, earliest);
    }
    return earliest;
  };
}

/** An earlier related resource's copy: its audit's id and its resource */
type Copy = { auditId: string; target: ResourceReference };

/**
 * The audit id and resource of an earlier related resource's copy, whose `SK` is
 * `{auditId}#{app}.{type}#{id}` for its resource; undefined for an audit, whose
 * `SK` is its id, which may hold a `#` too, even ending as a copy's would. Every
 * earlier SDK appended an attempt on each upsert of an audit and gave a copy none,
 * so only an item without attempts is a copy.
 *
 * From SDK 1.4.2 on, a copy's `target` is its resource. Before, a copy kept its
 * audit's `target` (and `resources`), and only its `SK` named its resource: it's
 * found among the copy's `resources`. A copy whose `SK` names no such resource, or
 * more than one, is refused with the reason, to be reconciled by hand.
 */
function copyOf(item: UnmarshalledAttributes): Copy | { reason: string } | undefined {
  if (Array.isArray(item.attempts) && item.attempts.length > 0) return undefined;

  const sortKey = String(item.SK ?? "");
  const auditId = (resource: Partial<ResourceReference> | undefined) => {
    if (!resource?.app || !resource.type || !hasResourceId(resource.id)) return undefined;
    const suffix = `#${resource.app}.${resource.type}#${resource.id}`;
    return sortKey.length > suffix.length && sortKey.endsWith(suffix)
      ? sortKey.slice(0, -suffix.length)
      : undefined;
  };

  const target = item.target as ResourceReference | undefined;
  const id = auditId(target);
  if (id !== undefined && target) return { auditId: id, target };

  // Before 1.4.2: one of its resources, each once however its id was typed
  const copies = new Map<string, Copy>();
  for (const resource of Array.isArray(item.resources) ? item.resources : []) {
    const id = auditId(resource as Partial<ResourceReference>);
    if (id === undefined) continue;
    const { app, type, id: resourceId } = resource as ResourceReference;
    const copy = { auditId: id, target: { app, type, id: resourceId } };
    copies.set(JSON.stringify([id, relatedSortKey(copy.target)]), copy);
  }
  if (copies.size === 1) return [...copies.values()][0];

  return {
    reason:
      copies.size > 1
        ? "A related resource's copy whose SK names more than one of its resources"
        : "An item without attempts, which isn't an audit, whose SK names neither its target nor one of its resources",
  };
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
function toCopy(item: UnmarshalledAttributes, { auditId, target }: Copy): Transformed {
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

  const summary = AuditSummarySchema.safeParse({ ...fields, target, id: auditId, createdAt });
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
      // The audit's key in the earlier table and in the v2 table
      audit: {
        from: {
          PK: tenantId
            ? `${tenantId}#${source.app}.${source.type}`
            : `${source.app}.${source.type}`,
          SK: auditId,
        },
        to: { PK: partition, SK: DynamoDB.SortKeys.AUDIT },
      },
      item: {
        ...copy,
        target,
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
 * What a merge leaves to the v2 audit, or sets itself: its keys, the attributes
 * built from its fields, and its expiry.
 */
const NOT_FILLED = new Set<string>([
  Keys.PARTITION_KEY,
  Keys.SORT_KEY,
  "attempts",
  "createdAt",
  Attributes.TTL,
  Attributes.TENANT_KEY,
  Attributes.APP,
  Attributes.RESOURCE_TYPE,
  Attributes.RESOURCE_ID,
  Attributes.KIND,
  Attributes.TRACE_ID,
  Attributes.TRACE_STAGE,
  Attributes.SCOPES,
  Attributes.MIGRATED,
]);

/**
 * Merges an earlier audit into the v2 audit an upsert wrote since the deploy: its
 * attempts go first, every attempt is renumbered by its position, the audit and
 * its copies take the earlier of the two `createdAt`s, and the audit is marked
 * `migrated`. The audit also gets the earlier audit's fields its upserts left out,
 * as an upsert keeps the fields it doesn't give (a rerun needs the `event`), with
 * the index attributes they add (a trace's).
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

  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
    const { Item } = await client.send(
      new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }),
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
    // The earlier audit's fields the upserts left out, and the index attributes they add
    const fields = Object.entries(audit).filter(
      ([name, value]) =>
        !NOT_FILLED.has(name) && current[name] === undefined && value !== undefined,
    );
    const merged = { ...current, ...Object.fromEntries(fields) } as Parameters<
      typeof constructIndexAttributes
    >[0];
    const filled = [
      ...fields,
      ...Object.entries(constructIndexAttributes(merged, DynamoDB.Kinds.AUDIT)).filter(
        ([name]) => current[name] === undefined,
      ),
    ];

    // First too: an interrupted run merges again, finding the audit unmerged
    await moveCopies(client, table, audit.PK, createdAt);
    try {
      await client.send(
        new UpdateItemCommand({
          TableName: table,
          Key: key,
          UpdateExpression: [
            "SET #attempts = :attempts, #createdAt = :createdAt, #migrated = :migrated",
            ...filled.map((_, i) => `#f${i} = :f${i}`),
          ].join(", "),
          // Unmerged and unchanged since the read: an upsert in between appended an attempt
          ConditionExpression:
            "attribute_not_exists(#migrated) AND #createdAt = :current AND size(#attempts) = :count",
          ExpressionAttributeNames: {
            "#attempts": "attempts",
            "#createdAt": "createdAt",
            "#migrated": Attributes.MIGRATED,
            ...Object.fromEntries(filled.map(([name], i) => [`#f${i}`, name])),
          },
          ExpressionAttributeValues: marshall(
            {
              ":attempts": attempts.map((item, i) => ({ ...item, number: i + 1 })),
              ":createdAt": createdAt,
              ":migrated": true,
              ":current": current.createdAt,
              ":count": current.attempts?.length ?? 0,
              ...Object.fromEntries(filled.map(([, value], i) => [`:f${i}`, value])),
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
