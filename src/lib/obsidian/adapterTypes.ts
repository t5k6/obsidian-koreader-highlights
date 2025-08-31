import type { DataAdapter, Stat } from "obsidian";

/**
 * A formal interface for Obsidian's DataAdapter, extended with the
 * non-standard but commonly available methods used by this plugin.
 * Using this interface provides type safety and simplifies mocking for tests.
 */
export interface ObsidianAdapter extends DataAdapter {
	/**
	 * Retrieves file or folder stats. This method is required by the base
	 * DataAdapter interface, but its implementation may vary or be a no-op
	 * on some platforms. Always check for its existence at runtime if unsure.
	 */
	stat(normalizedPath: string): Promise<Stat | null>;

	/**
	 * Retrieves the absolute base path of the vault on the filesystem.
	 * This is a non-standard extension and may not be present.
	 */
	getBasePath?(): string;

	/**
	 * Retrieves the full, absolute path for a given vault-relative path.
	 * This is a non-standard extension and may not be present.
	 */
	getFullPath?(path: string): string;
}
