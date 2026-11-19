import { ScanCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vite-plus/test";
import { main } from "./main.js";

const output = () => {
  const chunks: string[] = [];
  return { write: (text: string) => chunks.push(text), text: () => chunks.join("") };
};

const run = async (
  argv: string[],
  send = vi.fn(async (_command: unknown): Promise<unknown> => ({ Items: [] })),
) => {
  const stdout = output();
  const stderr = output();
  const code = await main(argv, {
    stdout,
    stderr,
    client: { send } as unknown as DynamoDBClient,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), send };
};

describe("aws-audit-migrate", () => {
  it("prints the report as JSON", async () => {
    const { code, stdout, send } = await run(["--from", "PROD-Audit", "--to", "PROD-Audit-v2"]);

    expect(code).toBe(0);
    expect(send.mock.calls[0][0]).toBeInstanceOf(ScanCommand);
    expect(JSON.parse(stdout)).toEqual({
      dryRun: false,
      scanned: 0,
      audits: { written: 0, existing: 0, merged: 0 },
      copies: { written: 0, existing: 0, ownTarget: 0 },
      scopes: { updated: 0, missingAudit: 0 },
      invalid: [],
    });
  });

  it("passes --dry-run through", async () => {
    const { stdout } = await run(["--from", "PROD-Audit", "--to", "PROD-Audit-v2", "--dry-run"]);

    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true });
  });

  it.each([
    [[]],
    [["--from", "PROD-Audit"]],
    [["--from", "PROD-Audit", "--to", "PROD-Audit"]],
    // One table could be named both ways
    [["--from", "arn:aws:dynamodb:us-east-1:123456789012:table/PROD-Audit", "--to", "PROD-Audit"]],
    [["--from", "PROD-Audit", "--to", "PROD-Audit-v2", "--concurrency", "0"]],
    [["--from", "PROD-Audit", "--to", "PROD-Audit-v2", "--unknown"]],
  ])("refuses %j with the usage", async (argv) => {
    const { code, stderr, send } = await run(argv);

    expect(code).toBe(2);
    expect(stderr).toContain("Usage: aws-audit-migrate");
    expect(send).not.toHaveBeenCalled();
  });

  it("prints the usage for --help", async () => {
    const { code, stdout } = await run(["--help"]);

    expect(code).toBe(0);
    expect(stdout).toContain("Usage: aws-audit-migrate");
  });

  it("fails with the error when the migration does", async () => {
    const { code, stderr } = await run(
      ["--from", "PROD-Audit", "--to", "PROD-Audit-v2"],
      vi.fn(async (_command: unknown): Promise<unknown> => {
        throw new Error("ResourceNotFoundException");
      }),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("Migration failed: ResourceNotFoundException");
  });
});
