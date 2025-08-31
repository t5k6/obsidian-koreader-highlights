import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig, mergeConfig } from "vitest/config";

// A shared configuration object to be applied to all projects.
const shared = {
	plugins: [tsconfigPaths()],
	resolve: {
		alias: {
			src: path.resolve(__dirname, "./src"),
			obsidian: path.resolve(__dirname, "./tests/setup/obsidian.mock.ts"),
		},
	},
	test: {
		globals: true,
	},
};

export default defineConfig({
	test: {
		// These settings are global for all projects.
		globals: true,
		setupFiles: ["./tests/setup/vitest.setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
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

		// Define explicit projects for different test environments.
		// A test file will be run by the FIRST project that includes it.
		projects: [
			// Project 1: For all tests that require a DOM environment.
			mergeConfig(shared, {
				test: {
					name: "dom",
					environment: "jsdom",
					include: [
						"**/ui/**/*.test.ts",
					],
				},
			}),

			// Project 2: For all other tests, running in a standard Node.js environment.
			mergeConfig(shared, {
				test: {
					name: "node",
					environment: "node",
					// Include all test files...
					include: ["tests/**/*.test.ts"],
					exclude: [
						"**/ui/**/*.test.ts",
					],
				},
			}),
		],
	},
});
