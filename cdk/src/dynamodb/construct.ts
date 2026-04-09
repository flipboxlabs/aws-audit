import type { CDKConfig } from "@flipboxlabs/aws-audit-cdk";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

import AuditTable from "./audit.js";

export class DynamoDBConstruct extends Construct {
  public readonly table: dynamodb.ITable;

  constructor(
    scope: Construct,
    id: string,
    props: {
      config: CDKConfig;
    },
  ) {
    super(scope, id);

    const { table } = new AuditTable(this, "AuditTable", props);

    this.table = table;
  }
}
