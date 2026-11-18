import type { Logger } from "@aws-lambda-powertools/logger";
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DynamoDB } from "./constants.js";
import {
  InvalidNextTokenError,
  InvalidResourceFilterError,
  ReservedTenantError,
} from "./errors.js";
import {
  AuditRepository,
  constructPrimaryKey,
  filterScope,
  joinKey,
  resourceScopes,
  type TypedListByStatusOptions,
  type TypedListItemsOptions,
  type TypedListObjectsOptions,
  type TypedListTraceItems,
} from "./repository.js";
import { encodeNextPageToken } from "./repository.utils.js";
import type { UpsertAuditInput } from "./schema/service.js";
import { AuditStorageSchema } from "./schema/storage.js";
import { App, ResourceType, testConfig } from "./test-config.js";

type ListItemsOptions = TypedListItemsOptions<typeof testConfig>;
type ListObjectsOptions = TypedListObjectsOptions<typeof testConfig>;
type ListTraceItems = TypedListTraceItems<typeof testConfig>;
type ListByStatusOptions = TypedListByStatusOptions<typeof testConfig>;

// Mock the DynamoDB client
vi.mock("@aws-sdk/client-dynamodb", async () => {
  const actual = await vi.importActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: class MockDynamoDBClient {
      send = vi.fn();
    },
  };
});

const TABLE = DynamoDB.Table.Name();
const CREATED_AT = "2026-01-02T03:04:05.678Z";

describe("AuditRepository", () => {
  let mockClient: {
    send: ReturnType<typeof vi.fn>;
  };
  let mockLogger: {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  let repository: AuditRepository<typeof testConfig>;

  /** An audit as the table stores it */
  const storedAudit = (overrides: Record<string, unknown> = {}) => ({
    PK: `-#${App.App1}#${ResourceType.ORDER}#audit-123`,
    SK: "audit",
    id: "audit-123",
    operation: "createOrder",
    status: "fail",
    tier: 1,
    target: { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
    trace: "trace-1:2",
    error: "Boom",
    attempts: [{ number: 1, status: "fail", at: CREATED_AT }],
    updatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    tenantKey: "-",
    app: App.App1,
    resourceType: ResourceType.ORDER,
    resourceId: "order-1",
    kind: "audit",
    traceId: "trace-1",
    traceStage: 2,
    scopes: new Set(["App1", "App1#Order", "*#Order", "App1#Order#order-1"]),
    ttl: 1775099045,
    ...overrides,
  });

  /** What a listing index returns for that audit: its keys and the summary */
  const indexRow = (overrides: Record<string, unknown> = {}) => {
    const { error: _, attempts: __, scopes: ___, ttl: ____, ...row } = storedAudit(overrides);
    return row;
  };

  const upsertInput = (
    overrides: Partial<UpsertAuditInput> = {},
  ): UpsertAuditInput & { id: string } =>
    ({
      id: "audit-123",
      operation: "createOrder",
      status: "fail",
      tier: 1,
      target: { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
      ...overrides,
    }) as UpsertAuditInput & { id: string };

  const attempt = { number: 1, status: "fail", at: CREATED_AT };

  /** The UpdateItem response: the audit as stored, for a first attempt */
  const updated = (
    attempts = [attempt],
    createdAt = CREATED_AT,
    overrides: Record<string, unknown> = {},
  ) => ({
    Attributes: marshall(storedAudit({ attempts, createdAt, ...overrides })),
  });

  /** The names and values an UpdateItem sets, unmarshalled */
  const setValues = (command: UpdateItemCommand) => {
    const { ExpressionAttributeNames: names = {}, ExpressionAttributeValues: values = {} } =
      command.input;
    const plain = unmarshall(values);
    return Object.fromEntries(
      Object.entries(names).map(([token, name]) => [name, plain[`:${token.slice(1)}`]]),
    );
  };

  const queryInput = (call = 0) => (mockClient.send.mock.calls[call][0] as QueryCommand).input;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    mockClient = {
      send: vi.fn(),
    };

    repository = new AuditRepository(
      mockLogger as unknown as Logger,
      testConfig,
      mockClient as unknown as DynamoDBClient,
    );
  });

  describe("constructor", () => {
    it("should create default client when not provided", () => {
      const repoWithDefaults = new AuditRepository(mockLogger as unknown as Logger, testConfig);

      expect(repoWithDefaults).toBeInstanceOf(AuditRepository);
    });
  });

  describe("getItem", () => {
    const identifiers = { id: "audit-123", app: App.App1, resourceType: ResourceType.ORDER };

    it("should read the audit's item", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.getItem(identifiers);

      const command = mockClient.send.mock.calls[0][0] as GetItemCommand;
      expect(command).toBeInstanceOf(GetItemCommand);
      expect(command.input).toEqual({
        TableName: TABLE,
        Key: marshall({ PK: "-#App1#Order#audit-123", SK: "audit" }),
      });
    });

    it("should prefix the partition key with the tenant", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.getItem({ ...identifiers, tenantId: "tenant-a" });

      const command = mockClient.send.mock.calls[0][0] as GetItemCommand;
      expect(command.input.Key).toEqual(
        marshall({ PK: "tenant-a#App1#Order#audit-123", SK: "audit" }),
      );
    });

    it("should return undefined when the item doesn't exist", async () => {
      mockClient.send.mockResolvedValue({});

      await expect(repository.getItem(identifiers)).resolves.toBeUndefined();
    });

    it("should return the whole audit without its storage attributes", async () => {
      mockClient.send.mockResolvedValue({ Item: marshall(storedAudit()) });

      const audit = await repository.getItem(identifiers);

      expect(audit).toEqual({
        id: "audit-123",
        operation: "createOrder",
        status: "fail",
        tier: 1,
        target: { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
        trace: "trace-1:2",
        error: "Boom",
        attempts: [{ number: 1, status: "fail", at: CREATED_AT }],
        updatedAt: new Date(CREATED_AT),
        createdAt: new Date(CREATED_AT),
      });
    });

    it.each(["trace", "tenantId"])("should omit a %s stored as NULL", async (name) => {
      mockClient.send.mockResolvedValue({ Item: marshall(storedAudit({ [name]: null })) });

      const audit = await repository.getItem(identifiers);

      expect(audit).not.toHaveProperty(name);
    });

    it("should log and rethrow DynamoDB errors", async () => {
      const error = new Error("DynamoDB error");
      mockClient.send.mockRejectedValue(error);

      await expect(repository.getItem(identifiers)).rejects.toBe(error);
      expect(mockLogger.error).toHaveBeenCalledWith("Failed to read audit item", {
        identifiers,
        error,
      });
    });

    it("should log and rethrow when the item fails schema parsing", async () => {
      mockClient.send.mockResolvedValue({
        Item: marshall(storedAudit({ target: "not-a-resource" })),
      });

      await expect(repository.getItem(identifiers)).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to read audit item",
        expect.objectContaining({ error: expect.any(Error) }),
      );
    });
  });

  describe("upsertItem", () => {
    it("should update the audit's item and return the attempt and the audit as stored", async () => {
      mockClient.send.mockResolvedValue(updated([attempt], "2025-12-31T00:00:00.000Z"));

      const result = await repository.upsertItem(upsertInput(), attempt);

      expect(result).toEqual({
        attemptNumber: 1,
        audit: {
          id: "audit-123",
          operation: "createOrder",
          status: "fail",
          tier: 1,
          target: { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
          trace: "trace-1:2",
          error: "Boom",
          attempts: [attempt],
          createdAt: "2025-12-31T00:00:00.000Z",
          updatedAt: CREATED_AT,
        },
      });
      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command).toBeInstanceOf(UpdateItemCommand);
      expect(command.input.TableName).toBe(TABLE);
      expect(command.input.Key).toEqual(marshall({ PK: "-#App1#Order#audit-123", SK: "audit" }));
      expect(command.input.ReturnValues).toBe("ALL_NEW");
    });

    it("should write empty strings as such, so the audit as stored is valid", async () => {
      // DynamoDB answers with the values set, as they were marshalled
      mockClient.send.mockImplementation(async (command: UpdateItemCommand) => {
        const { ExpressionAttributeNames: names = {}, ExpressionAttributeValues: values = {} } =
          command.input;
        const stored = Object.entries(names)
          .map(([token, name]) => [name, values[`:${token.slice(1)}`]] as const)
          .filter(([, value]) => value !== undefined);
        return { Attributes: { ...Object.fromEntries(stored), attempts: values[":newAttempt"] } };
      });

      const { audit } = await repository.upsertItem(
        upsertInput({
          target: { app: App.App1, type: ResourceType.ORDER, id: "" },
          context: { note: "" },
        }),
        attempt,
      );

      expect(audit.target).toEqual({ app: App.App1, type: ResourceType.ORDER, id: "" });
      expect(audit.context).toEqual({ note: "" });
    });

    it("should append the attempt and keep the first createdAt", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput(), attempt);

      const { UpdateExpression } = (mockClient.send.mock.calls[0][0] as UpdateItemCommand).input;
      expect(UpdateExpression).toContain(
        "#attempts = list_append(if_not_exists(#attempts, :emptyList), :newAttempt)",
      );
      expect(UpdateExpression).toContain("#createdAt = if_not_exists(#createdAt, :createdAt)");
    });

    it("should add to the audit's scopes, keeping those of resources a retry dropped", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput(), attempt);

      const { UpdateExpression } = (mockClient.send.mock.calls[0][0] as UpdateItemCommand).input;
      expect(UpdateExpression).toMatch(/ ADD #scopes :scopes$/);
      expect(UpdateExpression).not.toContain("#scopes = :scopes");
    });

    it("should set the attributes the indexes are keyed on", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(
        upsertInput({
          trace: "trace-1:2",
          resources: [
            { app: App.TestApp, type: ResourceType.USER, id: 7 },
            { app: App.App1, type: ResourceType.USER },
          ],
        }),
        attempt,
      );

      const values = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(values).toMatchObject({
        tenantKey: "-",
        app: "App1",
        resourceType: "Order",
        resourceId: "order-1",
        kind: "audit",
        traceId: "trace-1",
        traceStage: 2,
        scopes: new Set([
          "App1",
          "App1#Order",
          "*#Order",
          "App1#Order#order-1",
          "TestApp",
          "TestApp#User",
          "*#User",
          "TestApp#User#7",
          "App1#User",
        ]),
      });
    });

    it("should store an empty tenant id as none", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput({ tenantId: "" }), attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.Key).toEqual(marshall({ PK: "-#App1#Order#audit-123", SK: "audit" }));
      expect(setValues(command)).not.toHaveProperty("tenantId");
      expect(setValues(command)).toMatchObject({ tenantKey: "-" });
    });

    it("should key a tenant's audit by its tenant", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput({ tenantId: "tenant-a" }), attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(command.input.Key).toEqual(
        marshall({ PK: "tenant-a#App1#Order#audit-123", SK: "audit" }),
      );
      expect(setValues(command)).toMatchObject({ tenantKey: "tenant-a", tenantId: "tenant-a" });
    });

    it("should return the fields a retry kept, with its attempt renumbered", async () => {
      const retry = { number: 1, status: "success", at: CREATED_AT };
      mockClient.send.mockResolvedValue(
        updated([attempt, retry], "2025-12-31T00:00:00.000Z", { message: "Order failed" }),
      );

      const { audit } = await repository.upsertItem(upsertInput({ status: "success" }), retry);

      expect(audit.message).toBe("Order failed");
      expect(audit.attempts?.map(({ number }) => number)).toEqual([1, 2]);
    });

    it("should remove the resource id when the target has none, so it lists under its resource no more", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(
        upsertInput({ target: { app: App.App1, type: ResourceType.ORDER } }),
        attempt,
      );

      const { UpdateExpression, ExpressionAttributeNames } = (
        mockClient.send.mock.calls[0][0] as UpdateItemCommand
      ).input;
      expect(UpdateExpression).toMatch(/ ADD #scopes :scopes REMOVE #resourceId$/);
      expect(ExpressionAttributeNames).toMatchObject({ "#resourceId": "resourceId" });
    });

    it("should remove the trace attributes when the trace is cleared, so it leaves its trace's listing", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput({ trace: "" }), attempt);
      await repository.upsertItem(upsertInput({ trace: undefined }), attempt);

      const [cleared, kept] = mockClient.send.mock.calls.map(
        ([command]) => (command as UpdateItemCommand).input,
      );
      expect(cleared.UpdateExpression).toMatch(
        / ADD #scopes :scopes REMOVE #traceId, #traceStage$/,
      );
      expect(cleared.ExpressionAttributeNames).toMatchObject({
        "#trace": "trace",
        "#traceId": "traceId",
        "#traceStage": "traceStage",
      });
      expect(setValues({ input: cleared } as UpdateItemCommand).trace).toBe("");
      // A retry without a trace keeps the audit's
      expect(kept.UpdateExpression).not.toMatch(/REMOVE/);
    });

    it("should list a trace without an id under no trace, as an index key can't be empty", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput({ trace: ":2" }), attempt);

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      expect(setValues(command)).toMatchObject({ trace: ":2" });
      // Removed, not set
      expect(command.input.ExpressionAttributeValues).not.toHaveProperty(":traceId");
      expect(command.input.ExpressionAttributeValues).not.toHaveProperty(":traceStage");
      // It leaves an earlier trace's listing
      expect(command.input.UpdateExpression).toMatch(/ REMOVE #traceId, #traceStage$/);
    });

    it("should store a numeric resource id as a string", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(
        upsertInput({ target: { app: App.App1, type: ResourceType.ORDER, id: 0 } }),
        attempt,
      );

      const values = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(values.resourceId).toBe("0");
      expect(values.target).toEqual({ app: "App1", type: "Order", id: 0 });
    });

    it("should leave out the resource id and trace attributes when there are none", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(
        upsertInput({ target: { app: App.App1, type: ResourceType.ORDER } }),
        attempt,
      );

      const command = mockClient.send.mock.calls[0][0] as UpdateItemCommand;
      const values = setValues(command);
      // Removed, not set
      expect(command.input.ExpressionAttributeValues).not.toHaveProperty(":resourceId");
      expect(values).not.toHaveProperty("traceId");
      expect(values).not.toHaveProperty("traceStage");
      expect(values.scopes).toEqual(new Set(["App1", "App1#Order", "*#Order"]));
    });

    it("should use stage 0 for a trace without a stage", async () => {
      mockClient.send.mockResolvedValue(updated());

      await repository.upsertItem(upsertInput({ trace: "trace-1" }), attempt);

      const values = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(values).toMatchObject({ trace: "trace-1", traceId: "trace-1", traceStage: 0 });
    });

    it("should set the TTL from the configured seconds", async () => {
      mockClient.send.mockResolvedValue(updated());
      const { defineAuditConfig } = await import("./config.js");
      const customRepo = new AuditRepository(
        mockLogger as unknown as Logger,
        defineAuditConfig({ ...testConfig, ttlSeconds: 60 }),
        mockClient as unknown as DynamoDBClient,
      );

      const before = Math.floor(Date.now() / 1000);
      await customRepo.upsertItem(upsertInput(), attempt);
      const after = Math.floor(Date.now() / 1000);

      const { ttl } = setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand);
      expect(ttl).toBeGreaterThanOrEqual(before + 60);
      expect(ttl).toBeLessThanOrEqual(after + 60);
    });

    it("should add the default 90-day TTL in epoch seconds across a daylight saving change", async () => {
      // 90 days from January 2 crosses the March change in America/Denver
      vi.stubEnv("TZ", "America/Denver");
      vi.useFakeTimers({ now: new Date(CREATED_AT), toFake: ["Date"] });
      mockClient.send.mockResolvedValue(updated());

      try {
        await repository.upsertItem(upsertInput(), attempt);
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }

      // 2026-04-02T03:04:05Z
      expect(setValues(mockClient.send.mock.calls[0][0] as UpdateItemCommand).ttl).toBe(1775099045);
    });

    it("should throw when UpdateItem returns no attributes", async () => {
      mockClient.send.mockResolvedValue({});

      await expect(repository.upsertItem(upsertInput(), attempt)).rejects.toThrow(
        "UpdateItem did not return attributes",
      );
    });

    it("should renumber a retry on an existing item and ignore caller-supplied attempts", async () => {
      const retry = { number: 1, status: "success", at: "2026-01-03T00:00:00.000Z" };
      mockClient.send.mockResolvedValue(
        updated([
          { number: 1, status: "fail", at: "2026-01-01T00:00:00.000Z" },
          { number: 2, status: "fail", at: "2026-01-02T00:00:00.000Z" },
          retry,
        ]),
      );

      const result = await repository.upsertItem(
        upsertInput({ attempts: [{ number: 9, status: "fail", at: "2023-12-31T00:00:00Z" }] }),
        retry,
      );

      expect(result.attemptNumber).toBe(3);
      expect(mockClient.send).toHaveBeenCalledTimes(2);

      const [update, renumber] = mockClient.send.mock.calls.map(
        ([command]) => (command as UpdateItemCommand).input,
      );
      expect(update.ExpressionAttributeValues).not.toHaveProperty(":attempts");
      expect(update.ExpressionAttributeValues?.[":newAttempt"]).toEqual(marshall({ v: [retry] }).v);

      expect(renumber.Key).toEqual(update.Key);
      expect(renumber.UpdateExpression).toBe("SET #attempts[2].#number = :attemptNumber");
      expect(renumber.ExpressionAttributeNames).toEqual({
        "#attempts": "attempts",
        "#number": "number",
      });
      expect(renumber.ExpressionAttributeValues).toEqual({ ":attemptNumber": { N: "3" } });

      // The caller's attempt (number 9, 2023-12-31) reaches neither request
      for (const input of [update, renumber]) {
        expect(JSON.stringify(input)).not.toContain("2023-12-31");
      }
    });

    it.each<[string, Partial<UpsertAuditInput>]>([
      ["minimal", {}],
      [
        "full",
        {
          id: "audit-full",
          message: "Full input",
          rerunable: true,
          trace: "trace-123:2",
          source: { app: App.App1, type: ResourceType.USER, id: "user-1" },
          context: { region: "us-east-1", nested: { count: 2 } },
          event: { source: "test.service", "detail-type": "Tested", detail: { a: 1 } },
          error: "Connection timeout",
          attempts: [{ number: 1, status: "fail", at: "2023-12-31T00:00:00Z" }],
          createdAt: "2023-12-31T00:00:00.000Z",
          resources: [{ app: App.TestApp, type: ResourceType.USER, id: "user-2" }],
        },
      ],
      ["tenant", { tenantId: "tenant-abc" }],
      ["no target id", { target: { app: App.App1, type: ResourceType.ORDER } }],
    ])(
      "should only send expression names and values the update expression uses (%s)",
      async (_label, overrides) => {
        mockClient.send.mockResolvedValue(updated());

        await repository.upsertItem(upsertInput(overrides), attempt);

        const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } = (
          mockClient.send.mock.calls[0][0] as UpdateItemCommand
        ).input;
        const tokens = new Set(UpdateExpression?.match(/[#:][A-Za-z0-9_]+/g));

        // DynamoDB rejects names or values the expression doesn't use, and vice versa
        expect(new Set(Object.keys(ExpressionAttributeNames ?? {}))).toEqual(
          new Set([...tokens].filter((token) => token.startsWith("#"))),
        );
        expect(new Set(Object.keys(ExpressionAttributeValues ?? {}))).toEqual(
          new Set([...tokens].filter((token) => token.startsWith(":"))),
        );
      },
    );
  });

  describe("upsertRelated", () => {
    const puts = () =>
      mockClient.send.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof PutItemCommand)
        .map((command) => command.input);
    const putItems = () => puts().map(({ Item }) => unmarshall(Item ?? {}));
    const STORED = { createdAt: CREATED_AT, updatedAt: CREATED_AT };

    /** Writes the copies of `input` as upsertItem stored it */
    const upsertRelated = (
      input: UpsertAuditInput & { id: string },
      timestamps: { createdAt: string; updatedAt: string },
    ) =>
      repository.upsertRelated(
        AuditStorageSchema.parse({ ...input, ...timestamps }),
        input.resources,
      );

    it("should write a summary copy per related resource with an id", async () => {
      mockClient.send.mockResolvedValue({});

      await upsertRelated(
        upsertInput({
          trace: "trace-1:2",
          message: "Order failed",
          event: { source: "orders", "detail-type": "OrderCreated", detail: {} },
          error: "Boom",
          context: { region: "us-east-1" },
          resources: [
            { app: App.TestApp, type: ResourceType.USER, id: 7 },
            { app: App.App1, type: ResourceType.USER },
          ],
        }),
        { createdAt: "2025-12-31T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      );

      const [copy, ...rest] = putItems() ?? [];
      expect(rest).toEqual([]);
      expect(copy).toEqual({
        PK: "-#App1#Order#audit-123",
        SK: "related#TestApp#User#7",
        id: "audit-123",
        operation: "createOrder",
        status: "fail",
        tier: 1,
        message: "Order failed",
        trace: "trace-1:2",
        target: { app: "TestApp", type: "User", id: 7 },
        source: { app: "App1", type: "Order", id: "order-1" },
        rerunable: true,
        related: true,
        createdAt: "2025-12-31T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        tenantKey: "-",
        app: "TestApp",
        resourceType: "User",
        resourceId: "7",
        ttl: expect.any(Number),
        revision: 0,
      });
    });

    it("should copy the audit as stored, with the fields a retry kept", async () => {
      mockClient.send.mockResolvedValue({});

      await repository.upsertRelated(
        AuditStorageSchema.parse({
          ...upsertInput({ message: "Order failed", trace: "trace-1:2" }),
          ...STORED,
        }),
        [{ app: App.TestApp, type: ResourceType.USER, id: 7 }],
      );

      expect(putItems()?.[0]).toMatchObject({ message: "Order failed", trace: "trace-1:2" });
    });

    it("should key a tenant's copies under its audit", async () => {
      mockClient.send.mockResolvedValue({});

      await upsertRelated(
        upsertInput({
          tenantId: "tenant-a",
          resources: [{ app: App.TestApp, type: ResourceType.USER, id: "u" }],
        }),
        STORED,
      );

      expect(putItems()?.[0]).toMatchObject({
        PK: "tenant-a#App1#Order#audit-123",
        tenantId: "tenant-a",
        tenantKey: "tenant-a",
      });
    });

    it("should keep the audit's rerunable setting", async () => {
      mockClient.send.mockResolvedValue({});

      await upsertRelated(
        upsertInput({
          rerunable: false,
          event: { source: "orders", "detail-type": "OrderCreated", detail: {} },
          resources: [{ app: App.TestApp, type: ResourceType.USER, id: "u" }],
        }),
        STORED,
      );

      expect(putItems()?.[0].rerunable).toBe(false);
    });

    it("should write nothing without related resources that have an id", async () => {
      await upsertRelated(
        upsertInput({ resources: [{ app: App.TestApp, type: ResourceType.USER }] }),
        STORED,
      );
      await upsertRelated(upsertInput(), STORED);

      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it("should write one copy per resource, from its last listing", async () => {
      mockClient.send.mockResolvedValue({});

      await upsertRelated(
        upsertInput({
          resources: [
            { app: App.TestApp, type: ResourceType.USER, id: 1 },
            { app: App.TestApp, type: ResourceType.ORDER, id: "o" },
            { app: App.TestApp, type: ResourceType.USER, id: "1" },
          ],
        }),
        STORED,
      );

      expect(putItems().map(({ SK, target }) => ({ SK, target }))).toEqual([
        { SK: "related#TestApp#User#1", target: { app: "TestApp", type: "User", id: "1" } },
        { SK: "related#TestApp#Order#o", target: { app: "TestApp", type: "Order", id: "o" } },
      ]);
    });

    it("should leave out the audit's own target, which it lists under already", async () => {
      mockClient.send.mockResolvedValue({});

      await upsertRelated(
        upsertInput({
          resources: [
            { app: App.App1, type: ResourceType.ORDER, id: "order-1" },
            { app: App.TestApp, type: ResourceType.USER, id: "u" },
          ],
        }),
        STORED,
      );
      await upsertRelated(
        upsertInput({ resources: [{ app: App.App1, type: ResourceType.ORDER, id: "order-1" }] }),
        STORED,
      );

      expect(putItems()?.map(({ SK }) => SK)).toEqual(["related#TestApp#User#u"]);
    });

    describe("revisions", () => {
      const resources = [
        { app: App.TestApp, type: ResourceType.USER, id: "u" },
        { app: App.TestApp, type: ResourceType.ORDER, id: "o" },
      ];
      /** The audit after its second attempt */
      const retried = () =>
        repository.upsertRelated(
          AuditStorageSchema.parse({
            ...upsertInput(),
            ...STORED,
            attempts: [attempt, { ...attempt, number: 2 }],
          }),
          resources,
        );

      it("should put each copy as its audit's attempt count, over none of a later one", async () => {
        mockClient.send.mockResolvedValue({});

        await retried();

        expect(puts()).toHaveLength(2);
        for (const put of puts()) {
          expect(put.TableName).toBe(TABLE);
          expect(unmarshall(put.Item ?? {}).revision).toBe(2);
          expect(put.ConditionExpression).toBe(
            "attribute_not_exists(#revision) OR #revision <= :revision",
          );
          expect(put.ExpressionAttributeNames).toEqual({ "#revision": "revision" });
          expect(unmarshall(put.ExpressionAttributeValues ?? {})).toEqual({ ":revision": 2 });
        }
      });

      it("should leave a copy a later upsert wrote, and put the rest", async () => {
        mockClient.send
          .mockRejectedValueOnce(
            new ConditionalCheckFailedException({ message: "Condition failed", $metadata: {} }),
          )
          .mockResolvedValue({});

        await expect(retried()).resolves.toBeUndefined();

        expect(putItems().map(({ SK }) => SK)).toEqual([
          "related#TestApp#User#u",
          "related#TestApp#Order#o",
        ]);
      });

      it("should throw any other failure", async () => {
        mockClient.send.mockRejectedValue(new Error("Throttled"));

        await expect(retried()).rejects.toThrow("Throttled");
        expect(mockClient.send).toHaveBeenCalledTimes(1);
      });

      /** Reads back the audit as `stored`, and accepts every other request */
      const readBack = (stored: Record<string, unknown> | undefined) =>
        mockClient.send.mockImplementation(async (command: unknown) =>
          command instanceof GetItemCommand
            ? { Item: stored && marshall(stored, { removeUndefinedValues: true }) }
            : {},
        );
      const threeAttempts = [1, 2, 3].map((number) => ({ ...attempt, number }));

      it("should read the audit back once its copies are put", async () => {
        readBack(storedAudit({ attempts: threeAttempts }));

        await retried();

        const calls = mockClient.send.mock.calls.map(([command]) => command);
        const read = calls.at(-1);
        expect(calls.slice(-3, -1).every((command) => command instanceof PutItemCommand)).toBe(
          true,
        );
        expect(read).toBeInstanceOf(GetItemCommand);
        expect((read as GetItemCommand).input).toEqual({
          TableName: TABLE,
          Key: marshall({ PK: "-#App1#Order#audit-123", SK: "audit" }),
          ConsistentRead: true,
        });
        // A later upsert, which writes its own copies
        expect(puts()).toHaveLength(2);
      });

      it("should put the copies again from the audit a migration merged meanwhile", async () => {
        // The 1.x audit's attempt first, and its createdAt and message
        readBack(
          storedAudit({
            attempts: threeAttempts,
            createdAt: "2025-10-01T00:00:00.000Z",
            message: "From 1.x",
            migrated: true,
          }),
        );

        await retried();

        expect(
          putItems().map(({ SK, revision, createdAt, message }) => ({
            SK,
            revision,
            createdAt,
            message,
          })),
        ).toEqual([
          { SK: "related#TestApp#User#u", revision: 2, createdAt: CREATED_AT, message: undefined },
          { SK: "related#TestApp#Order#o", revision: 2, createdAt: CREATED_AT, message: undefined },
          {
            SK: "related#TestApp#User#u",
            revision: 3,
            createdAt: "2025-10-01T00:00:00.000Z",
            message: "From 1.x",
          },
          {
            SK: "related#TestApp#Order#o",
            revision: 3,
            createdAt: "2025-10-01T00:00:00.000Z",
            message: "From 1.x",
          },
        ]);
        expect(unmarshall(puts()[2].ExpressionAttributeValues ?? {})).toEqual({ ":revision": 3 });
      });

      const deletes = () =>
        mockClient.send.mock.calls
          .map(([command]) => command)
          .filter((command) => command instanceof DeleteItemCommand)
          .map(({ input }) => ({
            key: unmarshall(input.Key!),
            condition: input.ConditionExpression,
            names: input.ExpressionAttributeNames,
            values: unmarshall(input.ExpressionAttributeValues!),
          }));

      it("should delete a copy under a retry's target, which an earlier attempt listed", async () => {
        readBack(undefined);

        await retried();
        // A first attempt has no earlier copy
        await upsertRelated(upsertInput({ resources }), STORED);

        expect(mockClient.send.mock.calls[0][0]).toBeInstanceOf(DeleteItemCommand);
        expect(deletes()).toEqual([
          {
            key: { PK: "-#App1#Order#audit-123", SK: "related#App1#Order#order-1" },
            // Not one a later upsert put
            condition: "attribute_not_exists(#revision) OR #revision <= :revision",
            names: { "#revision": "revision" },
            values: { ":revision": 2 },
          },
        ]);
      });

      it("should delete the copy it put under the target an overlapping upsert gave the audit", async () => {
        readBack(
          storedAudit({
            attempts: threeAttempts,
            target: { app: App.TestApp, type: ResourceType.ORDER, id: "o" },
          }),
        );

        await retried();

        expect(mockClient.send.mock.calls.at(-1)?.[0]).toBeInstanceOf(DeleteItemCommand);
        expect(deletes().map(({ key, values }) => ({ key, values }))).toEqual([
          {
            key: { PK: "-#App1#Order#audit-123", SK: "related#App1#Order#order-1" },
            values: { ":revision": 2 },
          },
          {
            key: { PK: "-#App1#Order#audit-123", SK: "related#TestApp#Order#o" },
            values: { ":revision": 2 },
          },
        ]);
      });

      it("should leave a copy under the retry's target that a later upsert put", async () => {
        readBack(undefined);
        // The delete
        mockClient.send.mockRejectedValueOnce(
          new ConditionalCheckFailedException({ message: "Condition failed", $metadata: {} }),
        );

        await expect(retried()).resolves.toBeUndefined();
        expect(puts()).toHaveLength(2);
      });

      it("should neither delete nor put a copy whose key is longer than DynamoDB allows", async () => {
        mockClient.send.mockResolvedValue({});
        const long = "x".repeat(1100);
        const short = { app: App.TestApp, type: ResourceType.USER, id: "u" };

        await repository.upsertRelated(
          AuditStorageSchema.parse({
            ...upsertInput({ target: { app: App.App1, type: ResourceType.ORDER, id: long } }),
            ...STORED,
            attempts: [attempt, { ...attempt, number: 2 }],
          }),
          [{ app: App.TestApp, type: ResourceType.USER, id: long }, short],
        );

        // No copy could be stored under either, so there's none to delete
        expect(deletes()).toEqual([]);
        expect(putItems()?.map(({ target }) => target)).toEqual([short]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          "Related resource's id is too long for a copy to list it",
          expect.objectContaining({ id: "audit-123", bytes: 1121 }),
        );
      });

      it("should leave the copies when the audit was merged before its upsert, or is gone", async () => {
        readBack(storedAudit({ attempts: threeAttempts.slice(0, 2), migrated: true }));
        await retried();
        readBack(undefined);
        await retried();

        expect(puts()).toHaveLength(4);
      });
    });
  });

  describe("listings", () => {
    const keyCondition = (input: QueryCommand["input"]) => {
      const names = input.ExpressionAttributeNames ?? {};
      const values = unmarshall(input.ExpressionAttributeValues ?? {});
      return Object.fromEntries(
        (input.KeyConditionExpression ?? "")
          .split(" AND ")
          .map((condition) => condition.split(" = "))
          .map(([name, value]) => [names[name], values[value]]),
      );
    };

    type Listing = {
      name: string;
      index: string;
      forward: boolean;
      partition: Record<string, string>;
      list: (
        repository: AuditRepository<typeof testConfig>,
        extra?: Record<string, unknown>,
        pagination?: { pageSize?: number; nextToken?: string },
      ) => Promise<unknown>;
    };

    const LISTINGS: Listing[] = [
      {
        name: "listObjects",
        index: "ByType",
        forward: false,
        partition: { tenantKey: "-", app: "App1", resourceType: "Order" },
        list: (repo, extra, pagination) =>
          repo.listObjects(
            {
              app: App.App1,
              resource: { type: ResourceType.ORDER },
              ...extra,
            } as ListObjectsOptions,
            pagination,
          ),
      },
      {
        name: "listItems",
        index: "ByResource",
        forward: false,
        partition: { tenantKey: "-", app: "App1", resourceType: "Order", resourceId: "order-1" },
        list: (repo, extra, pagination) =>
          repo.listItems(
            {
              app: App.App1,
              resource: { type: ResourceType.ORDER, id: "order-1" },
              ...extra,
            } as ListItemsOptions,
            pagination,
          ),
      },
      {
        name: "listByStatus",
        index: "ByStatus",
        forward: false,
        partition: { tenantKey: "-", status: "fail", kind: "audit" },
        list: (repo, extra, pagination) =>
          repo.listByStatus({ status: "fail", ...extra } as ListByStatusOptions, pagination),
      },
      {
        name: "listTraceItems",
        index: "ByTrace",
        forward: true,
        partition: { tenantKey: "-", traceId: "trace-1" },
        list: (repo, extra, pagination) =>
          repo.listTraceItems({ trace: "trace-1", ...extra } as ListTraceItems, pagination),
      },
    ];

    /** A nextToken for the row's index keys, as DynamoDB would return it */
    const tokenFor = (listing: Listing, overrides: Record<string, unknown> = {}) => {
      const { partitionKeys, sortKeys } = Object.values(DynamoDB.Indexes).find(
        (index) => index.name === listing.index,
      )!;
      const row = indexRow(overrides) as Record<string, unknown>;
      return encodeNextPageToken(
        Object.fromEntries(
          ["PK", "SK", ...[...partitionKeys, ...sortKeys].map((key) => key.name)].map((name) => [
            name,
            row[name] as string | number,
          ]),
        ),
      );
    };

    describe.each(LISTINGS)("$name", (listing) => {
      it("should query its index partition", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });

        await listing.list(repository);

        const input = queryInput();
        expect(mockClient.send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
        expect(input).toMatchObject({
          TableName: TABLE,
          IndexName: listing.index,
          ScanIndexForward: listing.forward,
          Limit: 100,
        });
        expect(input.FilterExpression).toBeUndefined();
        expect(input.ExclusiveStartKey).toBeUndefined();
        expect(keyCondition(input)).toEqual(listing.partition);
      });

      it("should query a tenant's partition", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });

        await listing.list(repository, { tenantId: "tenant-a" });

        expect(keyCondition(queryInput())).toEqual({
          ...listing.partition,
          tenantKey: "tenant-a",
        });
      });

      it("should refuse the tenant id of audits without a tenant", async () => {
        await expect(listing.list(repository, { tenantId: "-" })).rejects.toThrow(
          new ReservedTenantError(),
        );
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it("should return summaries and a nextToken", async () => {
        const lastEvaluatedKey = { PK: "a", SK: "b" };
        mockClient.send.mockResolvedValue({
          Items: [marshall(indexRow(), { removeUndefinedValues: true })],
          LastEvaluatedKey: marshall(lastEvaluatedKey),
        });

        await expect(listing.list(repository)).resolves.toEqual({
          items: [
            {
              id: "audit-123",
              operation: "createOrder",
              status: "fail",
              tier: 1,
              target: { app: "App1", type: "Order", id: "order-1" },
              trace: "trace-1:2",
              updatedAt: CREATED_AT,
              createdAt: CREATED_AT,
            },
          ],
          pagination: { nextToken: encodeNextPageToken(lastEvaluatedKey) },
        });
      });

      it.each(["trace", "tenantId"])("should omit a %s stored as NULL", async (name) => {
        mockClient.send.mockResolvedValue({ Items: [marshall(indexRow({ [name]: null }))] });

        const { items } = (await listing.list(repository)) as { items: object[] };

        expect(items[0]).not.toHaveProperty(name);
      });

      it("should resume from a nextToken with the page size", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });
        const nextToken = tokenFor(listing);

        await listing.list(repository, {}, { pageSize: 5, nextToken });

        expect(queryInput()).toMatchObject({
          Limit: 5,
          ExclusiveStartKey: marshall(JSON.parse(Buffer.from(nextToken!, "base64url").toString())),
        });
      });

      it("should reject a nextToken holding another index's keys", async () => {
        const other = LISTINGS.find(({ index }) => index !== listing.index)!;

        await expect(
          listing.list(repository, {}, { nextToken: tokenFor(other) }),
        ).rejects.toBeInstanceOf(InvalidNextTokenError);
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it("should reject a nextToken from another partition", async () => {
        await expect(
          listing.list(repository, {}, { nextToken: tokenFor(listing, { tenantKey: "tenant-b" }) }),
        ).rejects.toBeInstanceOf(InvalidNextTokenError);
        expect(mockClient.send).not.toHaveBeenCalled();
      });

      it("should filter by operation and tier", async () => {
        mockClient.send.mockResolvedValue({ Items: [] });

        await listing.list(repository, { operation: "createOrder", tier: 1 });

        const input = queryInput();
        expect(input.FilterExpression).toBe("#operation = :operation AND #tier = :tier");
        expect(input.ExpressionAttributeNames).toMatchObject({
          "#operation": "operation",
          "#tier": "tier",
        });
        expect(unmarshall(input.ExpressionAttributeValues ?? {})).toMatchObject({
          ":operation": "createOrder",
          ":tier": 1,
        });
      });
    });

    describe.each(LISTINGS.filter(({ index }) => index === "ByStatus" || index === "ByTrace"))(
      "$name resource filters",
      (listing) => {
        it.each<[string, Record<string, unknown>, string]>([
          ["an app", { app: App.App1 }, "App1"],
          ["a resource type", { resource: { type: ResourceType.USER } }, "*#User"],
          [
            "an app and type",
            { app: App.App1, resource: { type: ResourceType.USER } },
            "App1#User",
          ],
          [
            "a resource",
            { app: App.App1, resource: { type: ResourceType.USER, id: 7 } },
            "App1#User#7",
          ],
        ])("should match %s in the audit's scopes", async (_label, filters, scope) => {
          mockClient.send.mockResolvedValue({ Items: [] });

          await listing.list(repository, { ...filters, tier: 3 });

          const input = queryInput();
          expect(input.FilterExpression).toBe("#tier = :tier AND contains(#scopes, :scope)");
          expect(input.ExpressionAttributeNames?.["#scopes"]).toBe("scopes");
          expect(unmarshall(input.ExpressionAttributeValues ?? {})[":scope"]).toBe(scope);
        });

        it("should refuse a resource id without its app and type", async () => {
          await expect(
            listing.list(repository, { resource: { type: ResourceType.USER, id: 7 } }),
          ).rejects.toThrow(InvalidResourceFilterError);
          expect(mockClient.send).not.toHaveBeenCalled();
        });
      },
    );
  });
});

describe("joinKey", () => {
  it("should escape %, # and * in each part", () => {
    expect(joinKey("100%", "a#b", "*", 0)).toBe("100%25#a%23b#%2A#0");
  });

  it("should never give audits of distinct tenants the same key", () => {
    const key = (tenantId: string, id: string) =>
      constructPrimaryKey({ tenantId, app: "App1", resourceType: "Order", id }).PK;

    expect(key("t1", "a#App1#Order#b")).toBe("t1#App1#Order#a%23App1%23Order%23b");
    expect(key("t1", "a#App1#Order#b")).not.toBe(key("t1#App1#Order#a", "b"));
  });

  it("should key an audit without a tenant under -, and refuse the tenant -", () => {
    expect(constructPrimaryKey({ app: "App1", resourceType: "Order", id: "a" }).PK).toBe(
      "-#App1#Order#a",
    );
    expect(() =>
      constructPrimaryKey({ tenantId: "-", app: "App1", resourceType: "Order", id: "a" }),
    ).toThrow(ReservedTenantError);
  });
});

describe("resourceScopes", () => {
  it("should name a resource by its app, app and type, type, and id", () => {
    expect(resourceScopes({ app: "App1", type: "Order", id: "o" })).toEqual([
      "App1",
      "App1#Order",
      "*#Order",
      "App1#Order#o",
    ]);
  });

  it("should leave out the id scope without an id", () => {
    expect(resourceScopes({ app: "App1", type: "Order" })).toEqual([
      "App1",
      "App1#Order",
      "*#Order",
    ]);
  });
});

describe("filterScope", () => {
  it("should return undefined without filters", () => {
    expect(filterScope({})).toBeUndefined();
    expect(filterScope({ resource: {} })).toBeUndefined();
  });

  it("should treat a resource id of 0 as an id", () => {
    expect(filterScope({ app: "App1", resource: { type: "Order", id: 0 } })).toBe("App1#Order#0");
  });
});
