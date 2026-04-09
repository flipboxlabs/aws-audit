import {
  CLOUDWATCH_LOGS,
  extractDataFromEnvelope,
} from "@aws-lambda-powertools/jmespath/envelopes";
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { AUDIT_LOG_IDENTIFIER, AuditService } from "@flipboxlabs/aws-audit-sdk";
import middy from "@middy/core";
import type { CloudWatchLogsEvent } from "aws-lambda";
import { auditConfig } from "../audit-config.js";

const logger = new Logger({
  logRecordOrder: ["level", "message"],
});

type LogMessage = {
  id: string;
  timestamp: number;
  message: string;
};

const service = new AuditService(logger, auditConfig);

const recordHandler = async (event: CloudWatchLogsEvent): Promise<void> => {
  const records = extractDataFromEnvelope<Array<LogMessage>>(event, CLOUDWATCH_LOGS);

  await Promise.allSettled(
    records.map(async (record) => {
      const message = JSON.parse(record.message);
      const audit = message[AUDIT_LOG_IDENTIFIER];

      if (!audit) {
        logger.warn("No audit log identifier found in message", { message });
        return;
      }

      try {
        logger.info("Storing audit to DynamoDB", { audit });

        return await service.upsertItem(audit).then((result) => {
          logger.info("Stored audit to DynamoDB", { result });

          return result;
        });
      } catch (error) {
        logger.error("An error was caught trying to save audit item", {
          error,
        });
      }
    }),
  );
};

export const handler = middy(async (event: CloudWatchLogsEvent) => recordHandler(event)).use(
  injectLambdaContext(logger, { logEvent: true }),
);
