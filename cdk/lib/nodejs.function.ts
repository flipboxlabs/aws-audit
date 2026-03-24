import type { CDKConfig } from "@nateiler/aws-audit-cdk";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export const ESMNodeFunctionFactory =
	(config: CDKConfig) =>
	(scope: Construct, id: string, props: nodejs.NodejsFunctionProps) => {
		const nodejsFunction = new nodejs.NodejsFunction(scope, id, {
			tracing: lambda.Tracing.ACTIVE,
			timeout: props.timeout || cdk.Duration.seconds(10),
			logRetention: props.logRetention || logs.RetentionDays.ONE_WEEK,
			memorySize: props.memorySize || 512,
			architecture: props.architecture || lambda.Architecture.ARM_64,
			runtime: lambda.Runtime.NODEJS_20_X,
			bundling: {
				minify: true,
				metafile: false,
				externalModules: ["aws-sdk", "@aws-sdk/*"],
				format: nodejs.OutputFormat.ESM,
				platform: "node",
				target: "esnext",
				mainFields: ["module", "main"],
				esbuildArgs: {
					"--conditions": "module",
					"--tree-shaking": "true",
				},
				banner:
					"import { createRequire } from 'module';const require = createRequire(import.meta.url);",
			},
			role:
				props.role ||
				new iam.Role(scope, `${id}-FunctionRole`, {
					assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
					managedPolicies: [
						iam.ManagedPolicy.fromAwsManagedPolicyName(
							"service-role/AWSLambdaBasicExecutionRole",
						),
					],
				}),
			...props,
			environment: {
				...props.environment,
				ENVIRONMENT: config.env,
				AWS_ACCOUNT: config.aws.account,
				POWERTOOLS_LOG_LEVEL: "WARN",
			},
		});

		nodejsFunction.addLayers(
			lambda.LayerVersion.fromLayerVersionArn(
				scope,
				`${id}InsightLayer`,
				`arn:aws:lambda:${
					cdk.Stack.of(scope).region
				}:580247275435:layer:LambdaInsightsExtension-Arm64:2`,
			),
		);

		return nodejsFunction;
	};
