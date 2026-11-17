/**
 * Records the parts of `contract/` that TypeScript still defines for the Rust
 * Lambdas (#93):
 *
 * - `schemas/{detail,items,objects,status,trace}.response`: JSON Schema 2020-12 for
 *   the audits the REST API answers with, generated from the SDK's
 *   `AuditPayloadSchema`. The SDK still reads and writes the same table.
 * - `fixtures/layer`: the `audit-config.json` the config layer writes for the
 *   Rust Lambdas.
 *
 * The HTTP and subscription fixtures and `config.response` were recorded from
 * the Node handlers, which are gone. They belong to the Rust Lambdas now and
 * change by hand along with them (see `contract/README.md`).
 *
 * The committed files are file snapshots, so this test fails when the SDK or the
 * layer drifts from them. Regenerate with `pnpm contract:update`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { AuditPayloadSchema, PaginationCollectionSchema } from "@flipboxlabs/aws-audit-sdk";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ConfigLayerConstruct } from "./lambda/construct.js";
import { testConfig } from "./test-config.js";

const SCHEMAS = "../../contract/schemas";
const LAYER = "../../contract/fixtures/layer";

/** The fixtures' clock: an attempt's `at` defaults to the time the schema is built */
const NOW = "2026-01-02T03:04:05.678Z";

const AuditCollectionSchema = PaginationCollectionSchema(AuditPayloadSchema);

/** Response schemas, by the route they answer */
const RESPONSE_SCHEMAS = {
  // GET /apps/{app}/objects/{object}/{item}/{audit}
  detail: AuditPayloadSchema,
  // GET /apps/{app}/objects/{object}/{item}
  items: AuditCollectionSchema,
  // GET /apps/{app}/objects/{object}
  objects: AuditCollectionSchema,
  // GET /status/{status}
  status: AuditCollectionSchema,
  // GET /trace/{trace}
  trace: AuditCollectionSchema,
} satisfies Record<string, z.ZodType>;

describe("contract", () => {
  beforeAll(() => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe("response schemas", () => {
    it.each(Object.entries(RESPONSE_SCHEMAS))("%s", async (name, schema) => {
      // Responses are validated as sent
      const jsonSchema = z.toJSONSchema(schema, {
        target: "draft-2020-12",
        io: "output",
        unrepresentable: "any",
      });

      await expect(`${JSON.stringify(jsonSchema, null, 2)}\n`).toMatchFileSnapshot(
        `${SCHEMAS}/${name}.response.schema.json`,
      );
    });
  });

  describe("layer", () => {
    it("audit-config.json", async () => {
      const app = new cdk.App();
      new ConfigLayerConstruct(new cdk.Stack(app, "Contract"), "AuditConfigLayer", {
        apps: testConfig.apps,
        resourceTypes: testConfig.resourceTypes,
      });

      const { directory } = app.synth();
      const [asset] = fs.readdirSync(directory).filter((entry) => entry.startsWith("asset."));

      // Byte for byte as Lambda will find it at /opt/audit-config.json
      await expect(
        fs.readFileSync(path.join(directory, asset, "audit-config.json"), "utf8"),
      ).toMatchFileSnapshot(`${LAYER}/audit-config.json`);
    });
  });
});
