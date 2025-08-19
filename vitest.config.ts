import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		globals: true,
		setupFiles: ["./tests/setup/vitest.setup.ts"],
		environment: "node",
		environmentMatchGlobs: [
			["**/ui/**/*.test.ts", "jsdom"],
			["tests/utils/**/*.test.ts", "jsdom"],
			["tests/services/parsing/**/*.test.ts", "jsdom"],
			["**/services/**/*.test.ts", "node"],
		],
		exclude: [
			// Never run tests from dependencies
			"node_modules/**",
			// Project-specific dead/placeholder suites
			"tests/**/SnapshotMigrationService.test.ts",
			"tests/**/parallelIndexProcessor.test.ts",
			// Common output folders
			"dist/**",
			"build/**",
			"coverage/**",
		],
		alias: {
			obsidian: path.resolve(__dirname, "./tests/setup/obsidian.mock.ts"),
		},
		coverage: {
			provider: "v8",
			reportsDirectory: "./coverage",
			thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
			exclude: [
				"node_modules/**",
				"tests/**",
				"**/*.test.*",
				"dist/**",
				"build/**",
			],
		},
		poolOptions: {
			threads: {
				singleThread: true,
			},
		},
	},
});
