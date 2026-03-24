import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

import AuditTable from "./audit.js";

export default class extends Construct {
	readonly table: dynamodb.ITable;

	constructor(
		scope: Construct,
		id: string,
		props: {
			config: CDKConfig;
		},
	) {
		super(scope, id);

		// Our audit table (w/ 365 day retention)
		const { table } = new AuditTable(scope, "AuditTable", props);
		this.table = table;
	}
}
