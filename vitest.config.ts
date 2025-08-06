import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		globals: true,
		setupFiles: ["./tests/setup/vitest.setup.ts"],
		environment: "jsdom",
		alias: {
			obsidian: path.resolve(__dirname, "./tests/setup/obsidian.mock.ts"),
		},
	},
});
