// Global Vitest setup to enforce strict test isolation and fail fast on async leaks

import { TFile, TFolder } from "obsidian";
import { afterEach } from "vitest";
import { harness } from "./testHarness";

// Fail tests on unhandled promise rejections to avoid silent timeouts
process.on("unhandledRejection", (reason) => {
	throw reason;
});

// Expose Obsidian classes once for instanceof checks across suites
(globalThis as any).TFile = TFile;
(globalThis as any).TFolder = TFolder;

// Single global teardown: reset harness (clears in-memory state and mocks)
afterEach(() => {
	vi.restoreAllMocks();
	harness.reset();
});
