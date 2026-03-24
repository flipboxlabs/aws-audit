import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts", "lib/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/construct.ts",
				"src/**/index.ts",
				"src/cloudwatch/**",
				"src/dynamodb/**",
				"lib/index.ts",
				"lib/nodejs.function.ts",
			],
		},
	},
});
