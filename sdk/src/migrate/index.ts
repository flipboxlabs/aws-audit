import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type * as z from "zod/v4";
import { DynamoDB } from "../constants.js";
import {
  KEY_BYTES,
  constructIndexAttributes,
  constructPrimaryKey,
  relatedCopy,
  relatedSortKey,
  resourceScopes,
  type UnmarshalledAttributes,
} from "../repository.js";
import { AuditSchema, AuditSummarySchema } from "../schema/audit.js";
import { DateTimeStringSchema, type ResourceReference } from "../schema/common.js";
import { type AuditStorage, AuditStorageSchema } from "../schema/storage.js";
import { hasResourceId, isRerunable } from "../utils.js";

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
  /** The earlier table's name (not its ARN), `{ENV}-{service}-Audit` */
  from: string;
  /** The v2 table's name (not its ARN), `{ENV}-{service}-Audit-v2` (`DynamoDB.Table.Name()`) */
  to: string;
  /** Read and transform only; write nothing */
  dryRun?: boolean;
  /** Writes in flight at once, across the whole run (default 10) */
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
  /**
   * Audits whose `scopes` gained their related resources, from their copies, and
   * whose copies were put again from them; `missingAudit`: copies' audits not in
   * the v2 table
   */
  scopes: { updated: number; missingAudit: number };
  /** Items that aren't valid audits or copies, which weren't copied */
  invalid: { PK: unknown; SK: unknown; reason: string }[];
};

type Key = { PK: string; SK: string };

/** An item to write */
type Write = { kind: "audits" | "copies"; item: UnmarshalledAttributes };

/**
 * Copies every audit of the earlier table into the v2 table.
 *
 * - An audit (`SK` its id) is written under its v2 key with its index
 *   attributes, keeping its fields, `createdAt` and `ttl`. A trace the earlier
 *   table kept only in its index keys is rebuilt from them.
 * - A related resource's copy (`SK` `{auditId}#{app}.{type}#{id}`, see
 *   {@link copyOf}) is written as a summary copy in its audit's partition, marked
 *   `related`. Its resource is added to the audit's `scopes`, so status and trace
 *   filters match it. A copy under the audit's own target is left out, as the
 *   audit lists there already.
 * - Once every item is written, each audit with copies is read as it stands (as
 *   written, or merged), and its copies are put again from it, as its revision
 *   (see `upsertRelated`): so a copy holds the audit's `createdAt` (the earlier
 *   table gave a copy the time of the audit's latest upsert) and fields, whatever
 *   order the scan found them in.
 *
 * `createdAt` and `updatedAt` are written with milliseconds, as the SDK writes
 * them: the earlier table kept a caller's text, and listings compare them as text.
 * The earlier SDK wrote empty strings as NULL: they're empty strings again where
 * a null isn't valid (see {@link withEmptyStrings}), and other top-level NULLs are
 * left out.
 *
 * Writes are conditional, so a run can be repeated and never replaces what the
 * new version has written since the deploy. Deploy first, then migrate. An audit
 * retried since the deploy has a v2 audit of its own: the earlier attempts are
 * put before its attempts, renumbered, it takes the earlier `createdAt`, and it gets the earlier audit's fields the retries left out (such
 * as the `event` a rerun sends). Each audit written or merged is marked `migrated`
 * (`DynamoDB.Attributes.MIGRATED`), which is how a later run knows to leave it.
 *
 * @returns What was copied, skipped and refused
 * @throws {RangeError} When `from` and `to` aren't the names of two different
 * tables ({@link tablesProblem}), or when `concurrency` isn't a positive integer
 */
export async function migrate(options: MigrationOptions): Promise<MigrationReport> {
  const { from, to, dryRun = false, concurrency = 10, onProgress } = options;
  const problem = tablesProblem(from, to);
  if (problem) {
    throw new RangeError(problem);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, not ${concurrency}`);
  }
  // Every write, wherever it's made, takes one of `concurrency` slots
  const writes = new WriteLimit(options.client, concurrency);
  try {
    return await run({ from, to, dryRun, concurrency, onProgress }, writes.client);
  } catch (error) {
    // No write starts once the run fails, and none is in flight when it returns,
    // so a caller that retries at once can't have two runs writing
    writes.stop(error);
    await writes.settled();
    throw writes.failure ?? error;
  }
}

/** A migration's run, whose writes go through `client` */
async function run(
  options: Omit<Required<MigrationOptions>, "client" | "onProgress"> &
    Pick<MigrationOptions, "onProgress">,
  client: DynamoDBClient,
): Promise<MigrationReport> {
  const { from, to, dryRun, concurrency, onProgress } = options;
  const report: MigrationReport = {
    scanned: 0,
    audits: { written: 0, existing: 0, merged: 0 },
    copies: { written: 0, existing: 0, ownTarget: 0 },
    scopes: { updated: 0, missingAudit: 0 },
    invalid: [],
  };

  // Related resources' scopes per audit partition, added once every audit is written
  const relatedScopes = new Map<string, Set<string>>();

  // Whether the earlier table holds an audit under a key, which only has attempts
  const readAudit = async (key: Key) => {
    const { Item } = await client.send(
      new GetItemCommand({
        TableName: from,
        Key: marshall(key),
        ProjectionExpression: "#attempts",
        ExpressionAttributeNames: { "#attempts": "attempts" },
      }),
    );
    const attempts = Item && unmarshall(Item).attempts;
    return Array.isArray(attempts) && attempts.length > 0;
  };

  const put = async ({ kind, item }: Write) => {
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

    // Per page, as copies of an audit are spread across the earlier table
    const audits = new Map<string, Promise<boolean>>();
    const isAudit = (key: Key) => {
      const name = JSON.stringify([key.PK, key.SK]);
      const read = audits.get(name) ?? readAudit(key);
      audits.set(name, read);
      return read;
    };

    const writes: Write[] = [];
    for (const raw of items) {
      report.scanned++;
      const item = unmarshall(raw);
      const copy = await copyOf(item, isAudit);
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

    await inBatches(writes, concurrency, put);
    startKey = lastKey;
    onProgress?.(report);
  } while (startKey);

  await inBatches([...relatedScopes], concurrency, async ([partition, scopes]) => {
    if (dryRun) {
      report.scopes.updated++;
      return;
    }

    let stored: UnmarshalledAttributes;
    try {
      const { Attributes: attributes } = await client.send(
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
          // The audit as it stands, which its copies are put again from
          ReturnValues: "ALL_NEW",
        }),
      );
      stored = unmarshall(attributes ?? {});
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      report.scopes.missingAudit++;
      return;
    }

    await putCopies(client, to, partition, AuditStorageSchema.parse(stored), {
      revision: (stored.attempts as unknown[] | undefined)?.length ?? 0,
      ttl: stored.ttl,
    });
    report.scopes.updated++;
  });

  return report;
}

type Transformed =
  | { write: Write; scopes?: { partition: string; values: string[] } }
  | { reason: string }
  | { ownTarget: true };

/** An earlier related resource's copy: its audit's id and its resource */
type Copy = { auditId: string; target: ResourceReference };

/**
 * A resource as an earlier copy's `SK` names it after its audit's id,
 * `{app}.{type}#{id}`, with app and type names as a v2 config allows (`NAME_PATTERN`).
 */
const SORT_KEY_RESOURCE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)#(.+)$/s;

/**
 * The audit id and resource of an earlier related resource's copy, whose `SK` is
 * `{auditId}#{app}.{type}#{id}` for its resource; undefined for an audit, whose
 * `SK` is its id, which may hold a `#` too, even ending as a copy's would. Every
 * earlier SDK appended an attempt on each upsert of an audit and gave a copy none,
 * so only an item without attempts is a copy. No earlier SDK stored `resources`.
 *
 * From SDK 1.4.2 on, a copy's `target` is its resource, which its `SK` ends with.
 * Before, a copy kept its audit's `target`, as its `source` too, and only its `SK`
 * named its resource, as text. As an audit's id may hold a `#`, and a resource's
 * id may end as a target does, a `SK` may read as more than one audit id and
 * resource. Each reading must name an audit under the copy's `source` in the
 * earlier table, which also refuses a copy SDK 1.4.1 wrote for an audit without
 * a given id (`undefined#{app}.{type}#{id}`). A copy that reads as no audit's,
 * or as more than one's, is refused with the reason, to be reconciled by hand.
 *
 * @param isAudit - Whether the earlier table holds an audit under this key
 */
async function copyOf(
  item: UnmarshalledAttributes,
  isAudit: (key: Key) => Promise<boolean>,
): Promise<Copy | { reason: string } | undefined> {
  if (Array.isArray(item.attempts) && item.attempts.length > 0) return undefined;

  const sortKey = String(item.SK ?? "");
  const target = item.target as ResourceReference | undefined;
  const source = item.source as ResourceReference | undefined;
  if (!source?.app || !source.type) {
    return { reason: "A related resource's copy needs a source" };
  }

  // Each reading once, however its resource id was typed
  const readings = new Map<string, Copy>();
  const read = (auditId: string, resource: ResourceReference) =>
    readings.set(JSON.stringify([auditId, relatedSortKey(resource)]), {
      auditId,
      target: resource,
    });

  // From 1.4.2: its target is its resource
  if (target?.app && target.type && hasResourceId(target.id)) {
    const suffix = `#${target.app}.${target.type}#${target.id}`;
    if (sortKey.length > suffix.length && sortKey.endsWith(suffix)) {
      read(sortKey.slice(0, -suffix.length), target);
    }
  }
  // Before 1.4.2: its target is its audit's, which its source is too
  if (target?.app && relatedSortKey(target) === relatedSortKey(source)) {
    for (let at = sortKey.indexOf("#", 1); at !== -1; at = sortKey.indexOf("#", at + 1)) {
      const [, app, type, id] = SORT_KEY_RESOURCE.exec(sortKey.slice(at + 1)) ?? [];
      if (app) read(sortKey.slice(0, at), { app, type, id });
    }
  }

  // Its audit is under its source, as the earlier SDK keyed it
  const PK = item.tenantId
    ? `${item.tenantId}#${source.app}.${source.type}`
    : `${source.app}.${source.type}`;
  const audits: Copy[] = [];
  for (const reading of readings.values()) {
    if (await isAudit({ PK, SK: reading.auditId })) audits.push(reading);
  }
  if (audits.length === 1) return audits[0];

  return {
    reason:
      readings.size === 0
        ? "An item without attempts, which isn't an audit, whose SK names neither its target nor a resource after an audit's id"
        : audits.length === 0
          ? "A related resource's copy whose SK names no audit in the earlier table"
          : "A related resource's copy whose SK reads as more than one audit's",
  };
}

/**
 * Why a v2 item can't be written, when a key attribute (of the table or an index)
 * is empty, or larger than DynamoDB allows: the escaped v2 keys are longer than the
 * earlier ones, so an item the earlier table took may not fit, and an index key may
 * be one the earlier table didn't have.
 */
function keyProblem(item: UnmarshalledAttributes): string | undefined {
  const keys = [
    { name: Keys.PARTITION_KEY, limit: KEY_BYTES.partition },
    { name: Keys.SORT_KEY, limit: KEY_BYTES.sort },
    ...Object.values(DynamoDB.Indexes).flatMap((index) => [
      ...index.partitionKeys.map(({ name }) => ({ name, limit: KEY_BYTES.partition })),
      ...index.sortKeys.map(({ name }) => ({ name, limit: KEY_BYTES.sort })),
    ]),
  ];
  for (const { name, limit } of keys) {
    const value = item[name];
    if (typeof value !== "string") continue;

    const bytes = Buffer.byteLength(value);
    if (bytes === 0) {
      return `Its v2 ${name} would be empty, which DynamoDB doesn't allow for a key`;
    }
    if (bytes > limit) {
      return `Its v2 ${name} would be ${bytes} bytes, over DynamoDB's ${limit}-byte limit for a key`;
    }
  }
  return undefined;
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

  const write: Write = {
    kind: "audits",
    item: {
      ...fields,
      id: String(id),
      createdAt: parsed.data.createdAt.toISOString(),
      updatedAt: parsed.data.updatedAt.toISOString(),
      // Index key attributes: defaulted when the earlier item left them out
      status: parsed.data.status,
      tier: parsed.data.tier,
      // As a v2 upsert stores it, which the earlier SDK didn't
      rerunable: isRerunable({ ...fields, status: parsed.data.status }),
      ...constructPrimaryKey({ tenantId, app: target.app, resourceType: target.type, id }),
      ...constructIndexAttributes({ tenantId, target, trace }, DynamoDB.Kinds.AUDIT),
      [Attributes.SCOPES]: new Set(resourceScopes(target)),
      [Attributes.MIGRATED]: true,
    },
  };
  const problem = keyProblem(write.item);
  return problem ? { reason: problem } : { write };
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

  const write: Write = {
    kind: "copies",
    item: {
      ...copy,
      target,
      id: auditId,
      createdAt: summary.data.createdAt,
      updatedAt: summary.data.updatedAt,
      status: summary.data.status,
      tier: summary.data.tier,
      // Put again from its audit once every audit is written, with the audit's flag
      rerunable: fields.rerunable ?? false,
      related: true,
      [Keys.PARTITION_KEY]: partition,
      [Keys.SORT_KEY]: relatedSortKey(target),
      ...constructIndexAttributes({ tenantId, target }, DynamoDB.Kinds.RELATED),
      ...(item.ttl === undefined ? {} : { ttl: item.ttl }),
    },
  };
  const problem = keyProblem(write.item);
  return problem
    ? { reason: problem }
    : { write, scopes: { partition, values: resourceScopes(target) } };
}

/**
 * An earlier item's fields without its keys, with its empty strings back and
 * without its other NULL attributes, with its trace as a string: one the item kept
 * only in its trace index keys is rebuilt from them (`{id}` at stage 0, else
 * `{id}:{stage}`). A NULL trace was an empty one, which cleared the trace, so it
 * isn't rebuilt from the keys an earlier upsert left.
 */
function withTrace(item: UnmarshalledAttributes): UnmarshalledAttributes {
  const restored = withEmptyStrings(
    Object.fromEntries(Object.entries(item).filter(([name]) => !V1_KEYS.includes(name))),
    AuditSchema,
  ) as UnmarshalledAttributes;
  const fields = Object.fromEntries(Object.entries(restored).filter(([, value]) => value !== null));
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
 * A value of an earlier item with the empty strings the earlier SDK wrote as NULL
 * (`convertEmptyValues`) back, so the v2 item is read as the audit was written:
 * each NULL where `schema` takes an empty string but not a null, such as an
 * `operation`, an event's `detail`, a `context` value or a target's id. A NULL
 * where a null is valid (an `error` object's) may be one, so it's kept, as is one
 * where an empty string isn't valid either.
 */
function withEmptyStrings(value: unknown, schema: z.ZodType): unknown {
  if (value === null) {
    return !schema.safeParse(null).success && schema.safeParse("").success ? "" : null;
  }

  const kinds = schemaKinds(schema);
  if (Array.isArray(value)) {
    const array = kinds.find((kind) => kind.type === "array");
    return array?.element ? value.map((v) => withEmptyStrings(v, array.element!)) : value;
  }
  if (typeof value === "object" && !(value instanceof Set)) {
    const object = kinds.find((kind) => kind.type === "object" || kind.type === "record");
    if (!object) return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, v]) => {
        const field = object.type === "object" ? object.shape?.[name] : object.valueType;
        return [name, field ? withEmptyStrings(v, field) : v];
      }),
    );
  }
  return value;
}

/** The parts of a zod schema's definition {@link schemaKinds} reads */
type SchemaDef = {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  getter?: () => z.ZodType;
  options?: z.ZodType[];
  shape?: Record<string, z.ZodType>;
  valueType?: z.ZodType;
  element?: z.ZodType;
};

/**
 * The definitions of the schemas a value may parse as: through optional, default,
 * pipe and lazy schemas, and each option of a union.
 */
function schemaKinds(schema: z.ZodType): SchemaDef[] {
  const def = schema._zod.def as unknown as SchemaDef;
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
      return schemaKinds(def.innerType!);
    case "pipe":
      return schemaKinds(def.in!);
    case "lazy":
      return schemaKinds(def.getter!());
    case "union":
      return def.options!.flatMap(schemaKinds);
    default:
      return [def];
  }
}

/** Reads of an audit a merge makes when an upsert changes it meanwhile */
const MERGE_ATTEMPTS = 5;

/**
 * What a merge leaves to the v2 audit, or sets itself: its keys, the attributes
 * built from its fields, its expiry, and whether it's rerunable, which the merged
 * audit decides.
 */
const NOT_FILLED = new Set<string>([
  Keys.PARTITION_KEY,
  Keys.SORT_KEY,
  "attempts",
  "createdAt",
  "rerunable",
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
 * attempts go first, every attempt is renumbered by its position, the audit takes
 * the earlier of the two `createdAt`s, and the audit is marked `migrated`. The
 * audit also gets the earlier audit's fields its upserts left out, as an upsert
 * keeps the fields it doesn't give (a rerun needs the `event`), with the index
 * attributes they add (a trace's).
 *
 * Its copies are put again from the merged audit, as its revision, the merged
 * attempt count. An upsert that wrote the audit before the merge and puts its
 * copies after it can't replace those, and reads the audit back to put a copy
 * the merge didn't find from the merged audit (see `upsertRelated`).
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
    // An upsert from before audits stored the flag left none: the latest status
    // decides, with the event the merge leaves, which may be the earlier audit's
    if (current.rerunable === undefined) {
      fields.push(["rerunable", isRerunable({ ...current, ...Object.fromEntries(fields) })]);
    }
    const merged = { ...current, ...Object.fromEntries(fields) } as Parameters<
      typeof constructIndexAttributes
    >[0];
    const filled = [
      ...fields,
      ...Object.entries(constructIndexAttributes(merged, DynamoDB.Kinds.AUDIT)).filter(
        ([name]) => current[name] === undefined,
      ),
    ];
    const renumbered = attempts.map((item, i) => ({ ...item, number: i + 1 }));
    // The audit as the merge leaves it, which its copies are put from
    const result = AuditStorageSchema.parse({ ...merged, attempts: renumbered, createdAt });
    const count = current.attempts?.length ?? 0;

    // First too, at the audit's revision: an interrupted run merges again, finding
    // the audit unmerged
    await putCopies(client, table, audit.PK, result, { revision: count, ttl: current.ttl });
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
              ":attempts": renumbered,
              ":createdAt": createdAt,
              ":migrated": true,
              ":current": current.createdAt,
              ":count": count,
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

    // Again, at the merged revision, which a copy put from the audit before the
    // merge can't replace: an upsert in between rewrote its copies
    await putCopies(client, table, audit.PK, result, {
      revision: renumbered.length,
      ttl: current.ttl,
    });
    return true;
  }

  throw new Error(`Audit ${audit.PK} changed on each of ${MERGE_ATTEMPTS} merges; run again`);
}

/**
 * Puts each copy in an audit's partition again from the audit, as `revision`
 * ({@link relatedCopy}), so it holds the audit's `createdAt` and fields; only over
 * a copy of the same or an earlier revision, and not one that expired meanwhile.
 * A copy under the audit's own target, from before a retry made that resource its
 * target, is deleted, as the audit lists there already. The copies are read
 * consistently, so one an upsert put just before is found.
 */
async function putCopies(
  client: DynamoDBClient,
  table: string,
  partition: string,
  audit: AuditStorage,
  { revision, ttl }: { revision: number; ttl?: number },
) {
  let startKey: QueryCommandOutput["LastEvaluatedKey"];

  do {
    const { Items: copies = [], LastEvaluatedKey: lastKey } = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :related)",
        ProjectionExpression: "#target",
        ExpressionAttributeNames: {
          "#pk": Keys.PARTITION_KEY,
          "#sk": Keys.SORT_KEY,
          "#target": "target",
        },
        ExpressionAttributeValues: marshall({
          ":pk": partition,
          ":related": DynamoDB.SortKeys.RELATED_PREFIX,
        }),
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );

    const own = hasResourceId(audit.target.id) ? relatedSortKey(audit.target) : undefined;
    await Promise.all(
      copies.map(async (copy) => {
        const { target } = unmarshall(copy) as { target: ResourceReference };
        const condition = {
          ConditionExpression:
            "attribute_exists(#pk) AND (attribute_not_exists(#revision) OR #revision <= :revision)",
          ExpressionAttributeNames: {
            "#pk": Keys.PARTITION_KEY,
            "#revision": Attributes.REVISION,
          },
          ExpressionAttributeValues: marshall({ ":revision": revision }),
        };
        try {
          if (relatedSortKey(target) === own) {
            await client.send(
              new DeleteItemCommand({
                TableName: table,
                Key: marshall({ [Keys.PARTITION_KEY]: partition, [Keys.SORT_KEY]: own }),
                ...condition,
              }),
            );
          } else {
            await client.send(
              new PutItemCommand({
                TableName: table,
                Item: marshall(relatedCopy(audit, target, { revision, ttl }), MARSHALL_OPTIONS),
                ...condition,
              }),
            );
          }
        } catch (error) {
          if (!(error instanceof ConditionalCheckFailedException)) throw error;
        }
      }),
    );
    startKey = lastKey;
  } while (startKey);
}

/** Runs `fn` over `items`, `size` at a time. */
/** A DynamoDB table name: 3 to 255 letters, digits, `_`, `-` and `.` */
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

/**
 * Why a migration can't run from `from` to `to`: each must be a table's name, and
 * not the same one, as merging a table into itself would add each audit's attempts
 * to it again. An ARN is refused, as one table could be named both ways.
 *
 * @internal
 */
export function tablesProblem(from: string | undefined, to: string | undefined) {
  if (!from || !to || !TABLE_NAME.test(from) || !TABLE_NAME.test(to)) {
    return "from and to must be table names, not ARNs";
  }
  return from === to ? "from and to must name two different tables" : undefined;
}

/**
 * A client whose writes (`PutItem`, `UpdateItem` and `DeleteItem`) wait for one of
 * `limit` slots, so a run never has more in flight, however many partitions or
 * copies it writes at once. Reads go straight through.
 *
 * Once a write fails (other than on its condition, which its caller handles), or
 * the run is stopped, the writes waiting for a slot are cancelled and no other
 * starts.
 */
class WriteLimit {
  readonly client: DynamoDBClient;
  /** What stopped the writes: the first write's failure, or the run's */
  failure: unknown;
  private stopped = false;
  private active = 0;
  private waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private idle: (() => void)[] = [];

  constructor(
    client: DynamoDBClient,
    private readonly limit: number,
  ) {
    this.client = {
      send: (command: Parameters<DynamoDBClient["send"]>[0]) =>
        [PutItemCommand, UpdateItemCommand, DeleteItemCommand].some(
          (type) => command instanceof type,
        )
          ? this.write(() => client.send(command))
          : client.send(command),
    } as unknown as DynamoDBClient;
  }

  /** Cancels the writes waiting for a slot, and refuses any other */
  stop(error: unknown) {
    if (this.stopped) return;
    this.stopped = true;
    this.failure ??= error;
    for (const { reject } of this.waiting.splice(0)) reject(cancelled());
  }

  /** Resolves once no write is in flight */
  settled(): Promise<void> {
    return this.active === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.idle.push(resolve));
  }

  private async write<T>(send: () => Promise<T>): Promise<T> {
    if (this.stopped) throw cancelled();
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    }

    try {
      return await send();
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) this.stop(error);
      throw error;
    } finally {
      // Handed straight to the next write waiting, if any
      const next = this.waiting.shift();
      if (next) {
        next.resolve();
      } else if (--this.active === 0) {
        for (const resolve of this.idle.splice(0)) resolve();
      }
    }
  }
}

/** A write that didn't start, as an earlier one failed */
const cancelled = () => new Error("Write cancelled, as the migration failed");

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}
