import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type AnyEventBridgeDetailType,
  AUDIT_LOG_IDENTIFIER,
  DynamoDB,
  EventBridge,
} from "./constants.js";

describe("constants", () => {
  describe("AUDIT_LOG_IDENTIFIER", () => {
    it("should be the expected identifier key", () => {
      expect(AUDIT_LOG_IDENTIFIER).toBe("_audit");
    });
  });

  describe("DynamoDB", () => {
    describe("Keys", () => {
      it("should have correct primary key names", () => {
        expect(DynamoDB.Keys.PARTITION_KEY).toBe("PK");
        expect(DynamoDB.Keys.SORT_KEY).toBe("SK");
      });

      it("should have correct GSI1_SS key names", () => {
        expect(DynamoDB.Keys.GSI1_SS_PARTITION_KEY).toBe("GSI1_SS_PK");
        expect(DynamoDB.Keys.GSI1_SS_SORT_KEY).toBe("GSI1_SS_SK");
      });

      it("should have correct GSI1_SN key names", () => {
        expect(DynamoDB.Keys.GSI1_SN_PARTITION_KEY).toBe("GSI1_SN_PK");
        expect(DynamoDB.Keys.GSI1_SN_SORT_KEY).toBe("GSI1_SN_SK");
      });

      it("should have correct LSI key names", () => {
        expect(DynamoDB.Keys.LSI1_S_SORT_KEY).toBe("LSI1_S_SK");
        expect(DynamoDB.Keys.LSI1_N_SORT_KEY).toBe("LSI1_N_SK");
      });
    });

    describe("Indexes", () => {
      it("should have correct GSI names", () => {
        expect(DynamoDB.Indexes.GSI1_SS).toBe("GSI1_SS");
        expect(DynamoDB.Indexes.GSI1_SN).toBe("GSI1_SN");
      });

      it("should have correct LSI names", () => {
        expect(DynamoDB.Indexes.LSI1_S).toBe("LSI1_S");
        expect(DynamoDB.Indexes.LSI1_N).toBe("LSI1_N");
      });
    });

    describe("Attributes", () => {
      it("should have correct TTL attribute name", () => {
        expect(DynamoDB.Attributes.TTL).toBe("ttl");
      });
    });

    describe("Table.Name", () => {
      it("should generate table name with custom config", () => {
        const name = DynamoDB.Table.Name({ env: "prod", service: "v1" });
        expect(name).toBe("PROD-v1-Audit");
      });

      it("should uppercase environment", () => {
        const name = DynamoDB.Table.Name({ env: "staging", service: "v1" });
        expect(name).toBe("STAGING-v1-Audit");
      });

      it("should use process.env.ENVIRONMENT when no config provided", () => {
        const originalEnv = process.env.ENVIRONMENT;
        const originalService = process.env.SERVICE;
        process.env.ENVIRONMENT = "test";
        process.env.SERVICE = "v1";

        const name = DynamoDB.Table.Name();
        expect(name).toBe("TEST-v1-Audit");

        process.env.ENVIRONMENT = originalEnv;
        process.env.SERVICE = originalService;
      });

      it("should omit service from name when not provided", () => {
        const name = DynamoDB.Table.Name({ env: "prod" });
        expect(name).toBe("PROD-Audit");
      });
    });

    describe("Table.ARN", () => {
      it("should generate full ARN with custom config", () => {
        const arn = DynamoDB.Table.ARN({
          env: "prod",
          service: "v1",
          aws: {
            region: "us-west-2",
            account: "123456789012",
          },
        });

        expect(arn).toBe("arn:aws:dynamodb:us-west-2:123456789012:table/PROD-v1-Audit");
      });

      it("should use process.env values when no config provided", () => {
        const originalRegion = process.env.AWS_REGION;
        const originalAccount = process.env.AWS_ACCOUNT;
        const originalEnv = process.env.ENVIRONMENT;
        const originalService = process.env.SERVICE;

        process.env.AWS_REGION = "eu-west-1";
        process.env.AWS_ACCOUNT = "987654321098";
        process.env.ENVIRONMENT = "dev";
        process.env.SERVICE = "v1";

        const arn = DynamoDB.Table.ARN();
        expect(arn).toBe("arn:aws:dynamodb:eu-west-1:987654321098:table/DEV-v1-Audit");

        process.env.AWS_REGION = originalRegion;
        process.env.AWS_ACCOUNT = originalAccount;
        process.env.ENVIRONMENT = originalEnv;
        process.env.SERVICE = originalService;
      });
    });
  });

  describe("EventBridge", () => {
    describe("Source", () => {
      it("should have correct source value", () => {
        expect(EventBridge.Source).toBe("Audit");
      });
    });

    describe("DetailType", () => {
      it("should have correct detail type values", () => {
        expect(EventBridge.DetailType.UPSERTED).toBe("Upserted");
        expect(EventBridge.DetailType.DELETED).toBe("Deleted");
      });

      it("should satisfy AnyEventBridgeDetailType", () => {
        const upserted: AnyEventBridgeDetailType = EventBridge.DetailType.UPSERTED;
        const deleted: AnyEventBridgeDetailType = EventBridge.DetailType.DELETED;

        expect(upserted).toBe("Upserted");
        expect(deleted).toBe("Deleted");
      });
    });

    describe("Bus.Name", () => {
      it("should generate bus name with custom config", () => {
        const name = EventBridge.Bus.Name({ env: "prod", service: "v1" });
        expect(name).toBe("PROD-v1-Audit");
      });

      it("should uppercase environment", () => {
        const name = EventBridge.Bus.Name({ env: "staging", service: "v1" });
        expect(name).toBe("STAGING-v1-Audit");
      });

      it("should use process.env.ENVIRONMENT when no config provided", () => {
        const originalEnv = process.env.ENVIRONMENT;
        const originalService = process.env.SERVICE;
        process.env.ENVIRONMENT = "test";
        process.env.SERVICE = "v1";

        const name = EventBridge.Bus.Name();
        expect(name).toBe("TEST-v1-Audit");

        process.env.ENVIRONMENT = originalEnv;
        process.env.SERVICE = originalService;
      });
    });

    describe("Bus.ARN", () => {
      it("should generate full ARN with custom config", () => {
        const arn = EventBridge.Bus.ARN({
          env: "prod",
          service: "v1",
          aws: {
            region: "us-west-2",
            account: "123456789012",
          },
        });

        expect(arn).toBe("arn:aws:events:us-west-2:123456789012:event-bus/PROD-v1-Audit");
      });

      it("should use process.env values when no config provided", () => {
        const originalRegion = process.env.AWS_REGION;
        const originalAccount = process.env.AWS_ACCOUNT;
        const originalEnv = process.env.ENVIRONMENT;
        const originalService = process.env.SERVICE;

        process.env.AWS_REGION = "eu-west-1";
        process.env.AWS_ACCOUNT = "987654321098";
        process.env.ENVIRONMENT = "dev";
        process.env.SERVICE = "v1";

        const arn = EventBridge.Bus.ARN();
        expect(arn).toBe("arn:aws:events:eu-west-1:987654321098:event-bus/DEV-v1-Audit");

        process.env.AWS_REGION = originalRegion;
        process.env.AWS_ACCOUNT = originalAccount;
        process.env.ENVIRONMENT = originalEnv;
        process.env.SERVICE = originalService;
      });

      it("should default region to us-east-1 when AWS_REGION is undefined", () => {
        const originalRegion = process.env.AWS_REGION;
        const originalAccount = process.env.AWS_ACCOUNT;
        const originalEnv = process.env.ENVIRONMENT;
        const originalService = process.env.SERVICE;

        delete process.env.AWS_REGION;
        process.env.AWS_ACCOUNT = "111222333444";
        process.env.ENVIRONMENT = "qa";
        process.env.SERVICE = "v1";

        const arn = EventBridge.Bus.ARN();
        expect(arn).toBe("arn:aws:events:us-east-1:111222333444:event-bus/QA-v1-Audit");

        process.env.AWS_REGION = originalRegion;
        process.env.AWS_ACCOUNT = originalAccount;
        process.env.ENVIRONMENT = originalEnv;
        process.env.SERVICE = originalService;
      });
    });
  });
});
