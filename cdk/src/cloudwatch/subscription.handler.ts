import { gunzipSync } from "node:zlib";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { AUDIT_LOG_IDENTIFIER, AuditService } from "@flipboxlabs/aws-audit-sdk";
import middy from "@middy/core";
import type {
  CloudWatchLogsDecodedData,
  CloudWatchLogsEvent,
  CloudWatchLogsLogEvent,
} from "aws-lambda";
import { auditConfig } from "../audit-config.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

const service = new AuditService(logger, auditConfig);

type UpsertInput = Parameters<typeof service.upsertItem>[0];

/** The audit an app logged on this line (`{"_audit": {...}}`), if any */
const auditFrom = (message: string): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }

  return parsed !== null && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)[AUDIT_LOG_IDENTIFIER]
    : undefined;
};

const storeAudit = async ({ message }: CloudWatchLogsLogEvent): Promise<void> => {
  const audit = auditFrom(message);

  if (audit === undefined || audit === null) {
    logger.warn("No audit log identifier found in message", { message });
    return;
  }

  try {
    logger.info("Storing audit to DynamoDB", { audit });

    await service.upsertItem(audit as UpsertInput);

    logger.info("Stored audit to DynamoDB");
  } catch (error) {
    logger.error("An error was caught trying to save audit item", {
      error,
    });
  }
};

const recordHandler = async (event: CloudWatchLogsEvent): Promise<void> => {
  const data = JSON.parse(
    gunzipSync(Buffer.from(event.awslogs.data, "base64")).toString("utf8"),
  ) as CloudWatchLogsDecodedData;

  // CloudWatch checks a new subscription's destination with a control message; it
  // holds no audits
  if (data.messageType !== "DATA_MESSAGE") {
    logger.debug("Skipping a CloudWatch Logs control message", {
      messageType: data.messageType,
    });
    return;
  }

  // Each record stands alone and failures are logged, not thrown: a retried batch
  // would add another attempt to every audit already stored
  await Promise.all(data.logEvents.map(storeAudit));
};

export const handler = middy(async (event: CloudWatchLogsEvent) => recordHandler(event)).use(
  injectLambdaContext(logger, { logEvent: true }),
);
