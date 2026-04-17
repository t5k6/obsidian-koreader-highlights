import { type App, Notice, type Plugin, parseYaml, type TFile } from "obsidian";
import { extractUidFromFrontmatter } from "src/core/uidRules";
import { parseBackupFilename } from "src/lib/backupCore";
import { getOptimalConcurrency, runPool } from "src/lib/concurrency";
import { isErr } from "src/lib/core/result";
import { formatDateForTimestamp } from "src/lib/formatting";
import { parseFrontmatter } from "src/lib/frontmatter";
import { Pathing } from "src/lib/pathing";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import type { NotePersistenceService } from "src/services/vault/NotePersistenceService";
import type { KoreaderHighlightImporterSettings, PluginData } from "src/types";
import { withProgress } from "src/ui/utils/progress";
import type { PluginDataStore } from "./PluginDataStore";
import { normalizeSettings } from "./settingsSchema";

type TickFn = ((message?: string) => void) & {
  setStatus: (message: string) => void;
  setTotal: (n: number) => void;
};

// --- Migration Manager ---

const runWithProgress = async (
  ctx: MigrationContext,
  files: TFile[],
  action: (tick: TickFn, signal: AbortSignal) => Promise<void>,
  title: string,
) => {
  await withProgress(ctx.app, files.length, action, { title });
};

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

/**
 * A deferred migration that runs in the background after plugin load.
 * Returns a Promise that the caller can optionally await or fire-and-forget.
 */
type DeferredMigrationFn = (
  ctx: MigrationContext,
  onComplete: (updatedData: PluginData) => Promise<void>,
) => Promise<void>;

interface DeferredMigration {
  id: string;
  fn: DeferredMigrationFn;
}

export class MigrationManager {
  private readonly log;
  private readonly migrations: Record<string, MigrationFn>;
  private readonly deferredMigrations: Record<string, DeferredMigrationFn>;
  private pendingDeferred: DeferredMigration[] = [];

  constructor(
    private app: App,
    private fs: FileSystemService,
    private loggingService: LoggingService,
    private pluginVersion?: string,
  ) {
    this.log = this.loggingService.scoped("MigrationManager");

    // Synchronous migrations that run during plugin load (must be fast)
    this.migrations = {
      "1.3.0-backfill-uids": this.migrateBackfillUids.bind(this),
      "1.3.0-rename-snapshots-to-uid": this.migrateSnapshotsToUid.bind(this),
      "1.3.0-resolve-uid-collisions": this.migrateResolveUidCollisions.bind(this),
      "1.3.0-upgrade-index-database": this.migrateIndexDatabase.bind(this),
    };

    // Deferred migrations that run in background after plugin is ready
    this.deferredMigrations = {
      "1.4.5-embed-uid-in-legacy-backup-filenames":
        this.migrateEmbedUidInLegacyBackupFilenamesDeferred.bind(this),
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

    // --- Phase 1: Synchronous migrations (block startup) ---
    const syncToRun = Object.entries(this.migrations).filter(
      ([id]) => !out.appliedMigrations.includes(id),
    );

    if (syncToRun.length > 0) {
      this.log.info(`Found ${syncToRun.length} synchronous migration(s) to apply.`);
      for (const [id, fn] of syncToRun) {
        try {
          this.log.info(`Running migration: ${id}`);
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
          this.log.error(`Migration failed: ${id}. Aborting further migrations.`, e);
          return out;
        }
      }
    }

    // --- Phase 2: Collect deferred migrations (don't block startup) ---
    this.pendingDeferred = Object.entries(this.deferredMigrations)
      .filter(([id]) => !out.appliedMigrations.includes(id))
      .map(([id, fn]) => ({ id, fn }));

    if (this.pendingDeferred.length > 0) {
      this.log.info(
        `${this.pendingDeferred.length} deferred migration(s) will run in background after plugin is ready.`,
      );
    }

    if (syncToRun.length > 0) {
      this.log.info("All synchronous migrations applied successfully.");
    }
    return out;
  }

  /**
   * Run deferred migrations in the background. Call after plugin is fully loaded.
   * Each migration runs sequentially but yields to the event loop internally.
   *
   * @param dataStore - The plugin data store, used to persist migration completion.
   * @param deps - Service dependencies needed by migrations.
   */
  public async runDeferred(
    dataStore: PluginDataStore,
    deps: {
      notePersistenceService: NotePersistenceService;
      localIndexService: IndexCoordinator;
      settings: KoreaderHighlightImporterSettings;
    },
  ): Promise<void> {
    if (this.pendingDeferred.length === 0) return;

    this.log.info(`Starting ${this.pendingDeferred.length} deferred migration(s)...`);

    for (const { id, fn } of this.pendingDeferred) {
      this.log.info(`Running deferred migration: ${id}`);

      try {
        await fn(
          {
            app: this.app,
            fs: this.fs,
            log: this.loggingService,
            data: await dataStore.load(),
            ...deps,
          },
          async (updatedData: PluginData) => {
            // Persist completion atomically
            const finalData = {
              ...updatedData,
              appliedMigrations: [...updatedData.appliedMigrations, id],
              lastPluginMigratedTo: this.pluginVersion ?? updatedData.lastPluginMigratedTo,
            };
            await dataStore.save(finalData);
            this.log.info(`Deferred migration complete and persisted: ${id}`);
          },
        );
      } catch (e) {
        this.log.error(`Deferred migration failed: ${id}. Will retry on next startup.`, e);
        // Don't abort other deferred migrations — they're independent
      }
    }

    this.pendingDeferred = [];
  }

  // --- Synchronous Migration Implementations ---

  private async migrateBackfillUids(ctx: MigrationContext): Promise<PluginData> {
    const files = await this.getHighlightFiles(ctx.settings.highlightsFolder);
    if (files.length === 0) return ctx.data;

    await runWithProgress(
      ctx,
      files,
      async (tick, signal) => {
        tick.setStatus("Upgrading notes with unique IDs...");
        for (const file of files) {
          if (signal.aborted) return;
          const r = await ctx.notePersistenceService.ensureId(file);
          if (isErr(r)) {
            this.log.warn(`Failed to assign UID to ${file.path} during migration`, r.error);
          }
          tick();
        }
      },
      "KOReader Importer Upgrade",
    );

    return ctx.data;
  }

  private async migrateSnapshotsToUid(ctx: MigrationContext): Promise<PluginData> {
    const files = await this.getHighlightFiles(ctx.settings.highlightsFolder);
    if (files.length === 0) return ctx.data;

    await runWithProgress(
      ctx,
      files,
      async (tick, signal) => {
        tick.setStatus("Migrating highlight snapshots...");
        for (const file of files) {
          if (signal.aborted) return;
          try {
            const uid = ctx.notePersistenceService.tryGetId(file);
            if (uid) {
              await ctx.notePersistenceService.migrateSingleLegacySnapshot(file, uid);
            }
          } catch (e) {
            this.log.warn(`Failed to migrate snapshot for ${file.path}`, e);
          }
          tick();
        }
      },
      "KOReader Importer Upgrade",
    );

    return ctx.data;
  }

  private async migrateResolveUidCollisions(ctx: MigrationContext): Promise<PluginData> {
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
          this.log.warn(`Failed to reassign UID for ${f.path} during migration`, r.error);
          continue;
        }
        filesReassigned++;
      }
    }

    if (collisions > 0) {
      this.log.info(
        `UID collision resolution complete: ${collisions} collision(s) found, ${filesReassigned} file(s) reassigned.`,
      );
      new Notice(`KOReader Importer: Resolved ${collisions} duplicate note ID(s).`);
    }
    return ctx.data;
  }

  private async migrateIndexDatabase(ctx: MigrationContext): Promise<PluginData> {
    this.log.info("Triggering index database schema upgrade and data backfill...");
    await ctx.localIndexService.whenReady();
    this.log.info("Index database migration check complete.");
    return ctx.data;
  }

  // --- Deferred Migration Implementations ---

  /**
   * Deferred version: reads each legacy backup's frontmatter to extract kohl-uid,
   * then renames the file to embed the UID in the filename.
   *
   * Uses concurrent processing with yielding to avoid blocking the UI.
   * Idempotent: files already in new format are skipped, so partial runs
   * resume correctly on next startup.
   */
  private async migrateEmbedUidInLegacyBackupFilenamesDeferred(
    ctx: MigrationContext,
    onComplete: (updatedData: PluginData) => Promise<void>,
  ): Promise<void> {
    const log = ctx.log.scoped("BackupFilenameMigration");
    log.info("Starting legacy backup filename migration (embedding UID)...");

    const backupDir = ctx.fs.joinPluginDataPath("backups");

    const filePaths = await ctx.fs.walkVaultDirPaths(backupDir, {
      recursive: true,
      extensions: ["md"],
    });

    if (filePaths.length === 0) {
      log.info("No backup files found. Migration skipped.");
      await onComplete(ctx.data);
      return;
    }

    log.info(`Found ${filePaths.length} backup file(s) to inspect.`);

    const metrics = {
      inspected: filePaths.length,
      alreadyNew: 0,
      renamed: 0,
      skipped: 0,
      failed: 0,
    };

    if (filePaths.length > 20) {
      new Notice(
        "KOReader Importer: Upgrading backup filenames in background. This is a one-time operation.",
        6000,
      );
    }

    const concurrency = getOptimalConcurrency({ min: 1, max: 3 });

    const resultsStream = runPool(
      filePaths,
      async (filePath: string) => {
        return this.migrateOneLegacyBackupFilename(ctx, filePath, log);
      },
      { concurrency },
    );

    for await (const result of resultsStream) {
      if (result.ok) {
        const outcome = result.value;
        switch (outcome) {
          case "already-new":
            metrics.alreadyNew++;
            break;
          case "renamed":
            metrics.renamed++;
            break;
          case "skipped":
            metrics.skipped++;
            break;
          case "failed":
            metrics.failed++;
            break;
        }
      } else {
        // Pool-level error (unexpected)
        metrics.failed++;
        log.warn("Unexpected pool error during backup migration", result.error);
      }
    }

    log.info("Legacy backup filename migration complete.", metrics);

    if (metrics.failed > 0) {
      log.warn(
        `${metrics.failed} backup(s) could not be renamed; they remain usable as legacy files.`,
      );
    }

    await onComplete(ctx.data);
  }

  /**
   * Process a single backup file for the UID-embedding migration.
   * Returns an outcome string for metrics aggregation.
   */
  private async migrateOneLegacyBackupFilename(
    ctx: MigrationContext,
    filePath: string,
    log: ReturnType<LoggingService["scoped"]>,
  ): Promise<"already-new" | "renamed" | "skipped" | "failed"> {
    try {
      const basename = Pathing.vaultBasenameOf(filePath);
      const parsed = parseBackupFilename(basename);
      if (!parsed) {
        return "skipped";
      }

      if (parsed.format === "new") {
        return "already-new";
      }

      // Legacy format: read frontmatter to extract UID.
      // This I/O only happens once per file, during this one-time migration.
      const contentRes = await ctx.fs.readVaultText(filePath);
      if (isErr(contentRes)) {
        log.warn(`Failed reading backup ${filePath}`, contentRes.error);
        return "failed";
      }

      const parsedFm = parseFrontmatter(contentRes.value);
      if (isErr(parsedFm)) {
        return "skipped";
      }

      const frontmatter = parsedFm.value.yamlContent
        ? ((parseYaml(parsedFm.value.yamlContent) as Record<string, unknown> | null) ?? {})
        : {};
      const uid = extractUidFromFrontmatter(frontmatter);
      if (!uid) {
        return "skipped";
      }

      const ts = formatDateForTimestamp(parsed.timestamp);
      const newBasename = `${parsed.safeBase}-${uid}-${parsed.pathHash}-${ts}.md`;
      const newPath = Pathing.joinVaultPath(Pathing.vaultDirname(filePath), newBasename);
      if (newPath === filePath) {
        return "already-new";
      }

      const existsRes = await ctx.fs.vaultExists(newPath);
      if (!isErr(existsRes) && existsRes.value) {
        log.warn(`Skipped rename due to existing target ${newPath}`);
        return "skipped";
      }

      const renameRes = await ctx.fs.renameVaultPath(filePath, newPath);
      if (isErr(renameRes)) {
        log.warn(`Failed renaming ${filePath} -> ${newPath}`, renameRes.error);
        return "failed";
      }

      return "renamed";
    } catch (error) {
      log.warn(`Unexpected error processing ${filePath}`, error);
      return "failed";
    }
  }

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
      await dataStore.updateSettings((current) => normalizeSettings({ ...current, ...legacyRaw }));
      await plugin.saveData(null as any);
      this.log.info("Legacy settings migration complete.");
    } catch (e) {
      this.log.warn("Legacy settings migration failed; proceeding without it.", e);
    }
  }
}
