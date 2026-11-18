import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { parseArgs } from "node:util";
import { migrate, type MigrationReport } from "./index.js";

const USAGE = `Usage: aws-audit-migrate --from <table> --to <table> [options]

Copies the audits of an aws-audit 1.x table into the v2 table. Deploy the new
version first; writes are conditional, so a run can be repeated.

Options:
  --from <table>         The earlier table, e.g. PROD-Orders-Audit
  --to <table>           The v2 table, e.g. PROD-Orders-Audit-v2
  --region <region>      AWS region (default: AWS_REGION, then the SDK's default)
  --concurrency <n>      Writes in flight at once, across the run (default: 10)
  --dry-run              Read and transform only; write nothing
  -h, --help             Show this help
`;

type Output = { write: (text: string) => unknown };

/**
 * Runs the `aws-audit-migrate` command.
 *
 * @param argv - The arguments after the command
 * @param io - Where the report and progress go, and the client to use
 * @returns The exit code: 0 when done, 1 when it failed, 2 for a usage error
 */
export async function main(
  argv: string[],
  io: { stdout: Output; stderr: Output; client?: DynamoDBClient } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        region: { type: "string" },
        concurrency: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    io.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }

  const concurrency = values.concurrency === undefined ? 10 : Number(values.concurrency);
  if (!values.from || !values.to || values.from === values.to) {
    io.stderr.write(`--from and --to must name two different tables\n\n${USAGE}`);
    return 2;
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    io.stderr.write(`--concurrency must be a positive integer\n\n${USAGE}`);
    return 2;
  }

  const client = io.client ?? new DynamoDBClient(values.region ? { region: values.region } : {});
  const progress = (report: MigrationReport) =>
    io.stderr.write(
      `scanned ${report.scanned}: ${report.audits.written} audits, ${report.copies.written} copies written\n`,
    );

  try {
    const report = await migrate({
      client,
      from: values.from,
      to: values.to,
      dryRun: values["dry-run"],
      concurrency,
      onProgress: progress,
    });

    if (report.invalid.length > 0) {
      io.stderr.write(`${report.invalid.length} items weren't valid audits; see "invalid"\n`);
    }
    io.stdout.write(`${JSON.stringify({ dryRun: values["dry-run"], ...report }, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Migration failed: ${(error as Error).message}\n`);
    return 1;
  }
}
