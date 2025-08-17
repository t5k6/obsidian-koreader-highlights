import {
	normalizePath,
	type Plugin,
	TFile,
	TFolder,
	type Vault,
} from "obsidian";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { NoteIdentityService } from "src/services/vault/NoteIdentityService";
import type { SnapshotManager } from "src/services/vault/SnapshotManager";
import type { KoreaderHighlightImporterSettings, PluginData } from "src/types";
import type { PluginDataStore } from "./PluginDataStore";
import { normalizeSettings } from "./settingsSchema";

// --- Migration Manager ---

type MigrationContext = {
	vault: Vault;
	fs: FileSystemService;
	log: LoggingService;
	data: PluginData;
	// optional deps; if absent, corresponding migrations will no-op
	snapshotManager?: SnapshotManager;
	noteIdentityService?: NoteIdentityService;
	settings?: KoreaderHighlightImporterSettings;
};

type MigrationFn = (ctx: MigrationContext) => Promise<PluginData>;

export class MigrationManager {
	private readonly log;
	private readonly migrations: Record<string, MigrationFn>;

	constructor(
		private vault: Vault,
		private fs: FileSystemService,
		private loggingService: LoggingService,
		// Optionally provided for diagnostics; if available, stored on data.lastPluginMigratedTo
		private pluginVersion?: string,
	) {
		this.log = this.loggingService.scoped("MigrationManager");
		this.migrations = {
			"2024-12-clean-legacy-logs": async ({ vault, log, data }) => {
				await this.cleanupOldLogFiles(vault, log);
				return data;
			},
			"2025-01-detox-hidden-folders": async ({ data }) => {
				// Placeholder for a future idempotent migration that may adjust settings paths.
				return data;
			},
			"1.3.0": async ({ vault, log, data }) => {
				await this.cleanupLegacyUserData(vault, log);
				return data;
			},
			// One-time migration: move legacy path-hash snapshots to UID-based snapshots (idempotent)
			"2025-08-migrate-legacy-snapshots": async (ctx) => {
				const { data, settings, snapshotManager, noteIdentityService } = ctx;
				if (!snapshotManager || !noteIdentityService) return data;
				const folder = settings?.highlightsFolder ?? "";
				const files = await this.listMarkdownInFolder(folder, {
					recursive: true,
				});
				for (const f of files) {
					try {
						const uid = (await this.tryEnsureUidFor(f, ctx)) ?? null;
						if (!uid) continue;
						await snapshotManager.migrateSingleLegacySnapshot(f, uid);
					} catch (e) {
						this.log.warn(`Legacy snapshot migration failed for ${f.path}`, e);
					}
				}
				return data;
			},
			// Detect and resolve UID collisions by reassigning newer duplicates
			"2025-08-resolve-uid-collisions": async (ctx) => {
				const { data, settings, noteIdentityService } = ctx;
				if (!noteIdentityService) return data;
				const folder = settings?.highlightsFolder ?? "";
				const summary = await noteIdentityService.resolveInFolder(folder, {
					recursive: true,
				});
				if (summary.collisions > 0) {
					this.log.info(
						`UID collision resolution: ${summary.collisions} uid(s), ${summary.filesReassigned} files reassigned.`,
					);
				}
				return data;
			},
		};
	}

	public async runAll(
		data: PluginData,
		deps?: {
			noteIdentityService?: NoteIdentityService;
			snapshotManager?: SnapshotManager;
			settings?: KoreaderHighlightImporterSettings;
		},
	): Promise<PluginData> {
		let out = { ...data };
		for (const [id, fn] of Object.entries(this.migrations)) {
			if (out.appliedMigrations.includes(id)) continue;
			try {
				this.log.info(`Running migration: ${id}`);
				// eslint-disable-next-line no-await-in-loop
				out = await fn({
					vault: this.vault,
					fs: this.fs,
					log: this.loggingService,
					data: out,
					settings: deps?.settings,
					noteIdentityService: deps?.noteIdentityService,
					snapshotManager: deps?.snapshotManager,
				});
				out = {
					...out,
					appliedMigrations: [...out.appliedMigrations, id],
					lastPluginMigratedTo: this.pluginVersion ?? out.lastPluginMigratedTo,
				};
			} catch (e) {
				this.log.error(`Migration failed: ${id}. Will not mark as applied.`, e);
				break;
			}
		}
		return out;
	}

	private async tryEnsureUidFor(
		file: TFile,
		ctx: MigrationContext,
	): Promise<string | null> {
		const ids = ctx.noteIdentityService;
		if (!ids) return null;
		try {
			const existing = ids.tryGetId(file as any);
			if (existing) return existing;
			const uid = await ids.ensureId(file as any);
			return uid;
		} catch (_e) {
			return null;
		}
	}
	// Local helper to list markdown files in a folder (recursive by default)
	private async listMarkdownInFolder(
		folder: string | TFolder,
		opts: { recursive?: boolean } = {},
	): Promise<TFile[]> {
		const recursive = opts.recursive ?? true;
		let root: TFolder | null = null;
		if (typeof folder === "string") {
			const af = this.vault.getAbstractFileByPath(folder);
			if (af instanceof TFolder) root = af;
		} else {
			root = folder;
		}
		if (!root) return [];

		const out: TFile[] = [];
		const stack: (TFile | TFolder)[] = [root];
		while (stack.length) {
			const cur = stack.pop()!;
			if (cur instanceof TFile) {
				if (cur.extension === "md") out.push(cur);
				continue;
			}
			for (const child of cur.children) {
				if (!recursive && child instanceof TFolder) continue;
				stack.push(child as TFile | TFolder);
			}
		}
		return out;
	}

	/**
	 * Migrates legacy settings stored via plugin.loadData() to the unified data store.
	 * Safe to run multiple times; no-op if no legacy data exists.
	 */
	public async migrateLegacySettingsIfNeeded(
		plugin: Plugin,
		dataStore: PluginDataStore,
	): Promise<void> {
		try {
			const legacyRaw = await plugin.loadData();
			if (!legacyRaw || Object.keys(legacyRaw).length === 0) return;

			this.log.info("Migrating legacy settings to new data store.");
			await dataStore.updateSettings((current) =>
				normalizeSettings({ ...current, ...legacyRaw }),
			);
			await plugin.saveData(null as any);
			this.log.info("Legacy settings migration complete.");
		} catch (e) {
			this.log.warn(
				"Legacy settings migration failed; proceeding without it.",
				e,
			);
		}
	}

	/* ---------------- Migration Implementations ------------------- */

	private async cleanupOldLogFiles(
		vault: Vault,
		log: LoggingService,
	): Promise<void> {
		const LEGACY_DIRS = ["koreader/logs", "koreader_importer_logs"];
		let removed = 0;

		for (const dir of LEGACY_DIRS) {
			const folder = vault.getAbstractFileByPath(dir);
			if (!(folder instanceof TFolder)) continue;

			const victims = folder.children.filter(
				(c): c is TFile =>
					c instanceof TFile && c.name.startsWith("koreader-importer_"),
			);

			await Promise.all(
				victims.map(async (f) => {
					try {
						await vault.delete(f);
						removed++;
					} catch (e) {
						log.warn(`Could not delete old log ${f.path}`, e);
					}
				}),
			);
		}
		if (removed > 0) {
			log.info(`Removed ${removed} old log files during migration.`);
		}
	}

	/**
	 * Removes legacy files from the plugin data directory after unified SQLite migration.
	 * - Deletes old JSON import index and backup.
	 * - Deletes any legacy index sqlite files except the current highlight_index.sqlite.
	 * - Deletes probe artifacts.
	 */
	private async cleanupLegacyUserData(
		vault: Vault,
		_log: LoggingService,
	): Promise<void> {
		try {
			const adapter = (vault as any).adapter as import("obsidian").DataAdapter;
			// Prefer FileSystemService for the correct plugin data directory.
			const pluginDataDir = normalizePath(this.fs.getPluginDataDir());

			// Determine the current database and its journal files dynamically.
			const currentDbPath = this.fs.joinPluginDataPath("index.db");
			const currentDbName = currentDbPath.split("/").pop()!;
			const currentDbJournalFiles = new Set<string>([
				`${currentDbName}-shm`,
				`${currentDbName}-wal`,
			]);

			const exists = await adapter.exists(pluginDataDir);
			if (!exists) return;

			const { files } = await adapter.list(pluginDataDir);
			let removed = 0;

			const isLegacySqlite = (p: string): boolean => {
				const name = p.split("/").pop() ?? p;
				// Keep the current DB and its journals
				if (name === currentDbName) return false;
				if (currentDbJournalFiles.has(name)) return false;
				// Legacy patterns to delete (old DB names and backups)
				return (
					/index.*\.sqlite(\.(bak|old))?$/i.test(name) ||
					name === "highlight_index.sqlite"
				);
			};

			for (const f of files) {
				const name = f.split("/").pop() ?? f;
				if (
					name === "import-index.json" ||
					name === "import-index.json.bak" ||
					name === "highlight_index.sqlite.__probe__" ||
					name === "index.db.__probe__" ||
					isLegacySqlite(f)
				) {
					try {
						await adapter.remove(f);
						removed++;
					} catch (_e) {
						this.log.warn(`Could not delete legacy user data file: ${f}`);
					}
				}
			}

			if (removed > 0) {
				this.log.info(`Removed ${removed} legacy files from plugin data dir.`);
			}
		} catch (_e) {
			this.log.warn("cleanupLegacyUserData failed", _e);
		}
	}
}
