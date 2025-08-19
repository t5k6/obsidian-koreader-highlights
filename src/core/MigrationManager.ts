import { type App, Notice, type Plugin, type TFile } from "obsidian";
import { isErr } from "src/lib/core/result";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import type { NotePersistenceService } from "src/services/vault/NotePersistenceService";
import type { KoreaderHighlightImporterSettings, PluginData } from "src/types";
import { withProgress } from "src/ui/utils/progress";
import type { PluginDataStore } from "./PluginDataStore";
import { normalizeSettings } from "./settingsSchema";

// --- Migration Manager ---

type MigrationContext = {
	app: App;
	fs: FileSystemService;
	log: LoggingService;
	data: PluginData;
	settings: KoreaderHighlightImporterSettings;
	notePersistenceService: NotePersistenceService;
	localIndexService: IndexCoordinator;
};

type MigrationFn = (ctx: MigrationContext) => Promise<PluginData>;

export class MigrationManager {
	private readonly log;
	private readonly migrations: Record<string, MigrationFn>;

	constructor(
		private app: App,
		private fs: FileSystemService,
		private loggingService: LoggingService,
		private pluginVersion?: string,
	) {
		this.log = this.loggingService.scoped("MigrationManager");

		// Ordered migrations for the architecture upgrade
		this.migrations = {
			"1.3.0-backfill-uids": this.migrateBackfillUids.bind(this),
			"1.3.0-rename-snapshots-to-uid": this.migrateSnapshotsToUid.bind(this),
			"1.3.0-resolve-uid-collisions":
				this.migrateResolveUidCollisions.bind(this),
			"1.3.0-upgrade-index-database": this.migrateIndexDatabase.bind(this),
		};
	}

	public async runAll(
		data: PluginData,
		deps: {
			notePersistenceService: NotePersistenceService;
			localIndexService: IndexCoordinator;
			settings: KoreaderHighlightImporterSettings;
		},
	): Promise<PluginData> {
		let out = { ...data };
		const migrationsToRun = Object.entries(this.migrations).filter(
			([id]) => !out.appliedMigrations.includes(id),
		);

		if (migrationsToRun.length === 0) return out;

		this.log.info(`Found ${migrationsToRun.length} new migrations to apply.`);
		for (const [id, fn] of migrationsToRun) {
			try {
				this.log.info(`Running migration: ${id}`);
				// eslint-disable-next-line no-await-in-loop
				out = await fn({
					app: this.app,
					fs: this.fs,
					log: this.loggingService,
					data: out,
					...deps,
				});
				out = {
					...out,
					appliedMigrations: [...out.appliedMigrations, id],
					lastPluginMigratedTo: this.pluginVersion ?? out.lastPluginMigratedTo,
				};
			} catch (e) {
				this.log.error(
					`Migration failed: ${id}. Aborting further migrations.`,
					e,
				);
				return out; // stop to prevent partial migration corruption
			}
		}
		this.log.info("All pending migrations applied successfully.");
		return out;
	}

	// --- Migration Implementations ---

	private async migrateBackfillUids(
		ctx: MigrationContext,
	): Promise<PluginData> {
		const files = await this.getHighlightFiles(ctx.settings.highlightsFolder);
		if (files.length === 0) return ctx.data;

		await withProgress(
			ctx.app,
			files.length,
			async (tick, signal) => {
				tick.setStatus("Upgrading notes with unique IDs...");
				for (const file of files) {
					if (signal.aborted) return;
					const r = await ctx.notePersistenceService.ensureId(file);
					if (isErr(r)) {
						this.log.warn(
							`Failed to assign UID to ${file.path} during migration`,
							r.error,
						);
					}
					tick();
				}
			},
			{ title: "KOReader Importer Upgrade" },
		);

		return ctx.data;
	}

	private async migrateSnapshotsToUid(
		ctx: MigrationContext,
	): Promise<PluginData> {
		const files = await this.getHighlightFiles(ctx.settings.highlightsFolder);
		if (files.length === 0) return ctx.data;

		await withProgress(
			ctx.app,
			files.length,
			async (tick, signal) => {
				tick.setStatus("Migrating highlight snapshots...");
				for (const file of files) {
					if (signal.aborted) return;
					try {
						const uid = ctx.notePersistenceService.tryGetId(file);
						if (uid) {
							await ctx.notePersistenceService.migrateSingleLegacySnapshot(
								file,
								uid,
							);
						}
					} catch (e) {
						this.log.warn(`Failed to migrate snapshot for ${file.path}`, e);
					}
					tick();
				}
			},
			{ title: "KOReader Importer Upgrade" },
		);

		return ctx.data;
	}

	private async migrateResolveUidCollisions(
		ctx: MigrationContext,
	): Promise<PluginData> {
		// Scan all markdown files in the highlights folder
		const scan = await ctx.fs.getFilesInFolder(ctx.settings.highlightsFolder, {
			extensions: ["md"],
			recursive: true,
		});
		const files = scan.files;
		if (files.length === 0) return ctx.data;

		// Build UID -> files map using fast cache reads
		const byUid = new Map<string, TFile[]>();
		for (const f of files) {
			const uid = ctx.notePersistenceService.tryGetId(f);
			if (!uid) continue;
			const arr = byUid.get(uid) ?? [];
			arr.push(f);
			byUid.set(uid, arr);
		}

		let collisions = 0;
		let filesReassigned = 0;
		for (const [, arr] of byUid.entries()) {
			if (arr.length <= 1) continue;
			// Keep oldest by ctime, reassign others
			arr.sort((a, b) => a.stat.ctime - b.stat.ctime);
			const toReassign = arr.slice(1);
			collisions++;
			for (const f of toReassign) {
				const r = await ctx.notePersistenceService.assignNewId(f);
				if (isErr(r)) {
					this.log.warn(
						`Failed to reassign UID for ${f.path} during migration`,
						r.error,
					);
					continue;
				}
				filesReassigned++;
			}
		}

		if (collisions > 0) {
			this.log.info(
				`UID collision resolution complete: ${collisions} collision(s) found, ${filesReassigned} file(s) reassigned.`,
			);
			new Notice(
				`KOReader Importer: Resolved ${collisions} duplicate note ID(s).`,
			);
		}
		return ctx.data;
	}

	private async migrateIndexDatabase(
		ctx: MigrationContext,
	): Promise<PluginData> {
		this.log.info(
			"Triggering index database schema upgrade and data backfill...",
		);
		await ctx.localIndexService.whenReady();
		this.log.info("Index database migration check complete.");
		return ctx.data;
	}

	// --- Helpers ---

	private async getHighlightFiles(folderPath: string): Promise<TFile[]> {
		const scan = await this.fs.getFilesInFolder(folderPath, {
			extensions: ["md"],
			recursive: true,
		});
		return scan.files;
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
}
