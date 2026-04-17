import type { App, TFile } from "obsidian";
import {
  extractUidFromFrontmatter,
  generateUid as genUid,
  updateUidFrontmatter,
  validateUid,
} from "src/core/uidRules";
import {
  backupGroupKey,
  getBackupPathHash,
  type ParsedBackupFilename,
  parseBackupFilename,
} from "src/lib/backupCore";
import { getOptimalConcurrency, KeyedQueue, runPool } from "src/lib/concurrency";
import { sha1Hex } from "src/lib/core/crypto";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import { toFailure } from "src/lib/errors/mapper";
import { type AppFailure, type AppResult, isAppFailure } from "src/lib/errors/types";
import { Pathing } from "src/lib/pathing";
import {
  composeSnapshotContent,
  computeSnapshotHash,
  generateBackupFileName,
  legacySnapshotPathFor,
  snapshotErrors,
  snapshotPathForUid,
  verifySnapshotIntegrity,
} from "src/lib/snapshotCore";
import type { ImportWarning } from "src/services/import/types";
import type { NoteEditorService } from "src/services/parsing/NoteEditorService";
import { notifyOnFsError } from "src/services/ui/notificationUtils";
import type { NoteUpdater } from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { VaultBookScanner } from "./VaultBookScanner";

// consolidated error type for all persistence operations.
type NotePersistenceFailure = AppFailure;

/**
 * Information about a backup file for display in the UI.
 */
export interface BackupInfo {
  path: string;
  basename: string;
  size: number;
  timestamp: Date;
  formattedTime: string;
}

interface ParsedBackupEntry {
  path: string;
  basename: string;
  size: number;
  parsed: ParsedBackupFilename;
}

/**
 * A cohesive service responsible for a note's persistent state, including its
 * unique identity (kohl-uid) and historical snapshots for 3-way merging.
 */
export class NotePersistenceService {
  private readonly log;
  private readonly snapshotDir: string;
  private readonly backupDir: string;
  private readonly queue = new KeyedQueue();
  private isGCRunning = false;
  private deletionsSinceLastGC = 0;

  private addWarning(
    warnings: ImportWarning[],
    code: ImportWarning["code"],
    message: string,
  ): void {
    warnings.push({ code, message });
  }

  private buildPersistenceResult(
    file: TFile,
    uid: string,
    warnings: ImportWarning[],
  ): AppResult<{
    file: TFile;
    uid: string;
    snapshotCreated: boolean;
    warnings?: ImportWarning[];
  }> {
    const snapshotCreated = !warnings.some((warning) => warning.code === "SNAPSHOT_FAILED");
    return ok({
      file,
      uid,
      snapshotCreated,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  private async tryCreateSnapshot(
    file: TFile,
    uid: string,
    content: string,
    warnings: ImportWarning[],
    failureMessage: string,
  ): Promise<void> {
    const snapshotResult = await this.createSnapshotFromContent(uid, content, file.path);
    if (isErr(snapshotResult)) {
      this.addWarning(warnings, "SNAPSHOT_FAILED", failureMessage);
    }
  }

  constructor(
    private readonly app: App,
    private readonly noteEditorService: NoteEditorService,
    private readonly fs: FileSystemService,
    private readonly loggingService: LoggingService,
    private readonly vaultScanner: VaultBookScanner,
  ) {
    this.log = this.loggingService.scoped("NotePersistenceService");
    this.snapshotDir = this.fs.joinPluginDataPath("snapshots");
    this.backupDir = this.fs.joinPluginDataPath("backups");
  }

  private withFileLock<T>(fileOrPath: TFile | string, task: () => Promise<T>): Promise<T> {
    const path = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
    return this.queue.run(`file:${path}`, task);
  }

  public generateUid(): string {
    return genUid();
  }

  public tryGetId(file: TFile): string | undefined {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return extractUidFromFrontmatter(fm as Record<string, unknown>);
  }

  public async ensureId(file: TFile): Promise<Result<string, AppFailure>> {
    const existingUid = this.tryGetId(file);
    if (validateUid(existingUid)) {
      return ok(existingUid);
    }
    return this.assignNewId(file, existingUid);
  }

  public async assignNewId(
    file: TFile,
    oldUid?: string,
    opts?: { targetUid?: string },
  ): Promise<Result<string, AppFailure>> {
    return this.withFileLock(file, async () => {
      const newUid = opts?.targetUid ?? this.generateUid();

      if (!oldUid || oldUid === newUid) {
        // Pass through targetUid for idempotency
        return this.updateFrontmatterUid(file, newUid);
      }

      return this.withTwoSnapshotLocks(oldUid, newUid, async () => {
        const status = await this.checkMigrationStatus(oldUid, newUid);

        if (status.oldExists && !status.newExists) {
          const read = await this.readSnapshot(oldUid);
          if (isErr(read)) return err(read.error as AppFailure);

          const write = await this.writeSnapshot(newUid, read.value);
          if (isErr(write)) return err(write.error as AppFailure);
        } else if (!status.oldExists) {
          this.log.warn(
            `assignNewId: No snapshot for old UID ${oldUid}; proceeding without baseline.`,
          );
        }

        const commit = await this.updateFrontmatterUid(file, newUid);

        // If frontmatter update fails, roll back any newly-created snapshot.
        if (isErr(commit)) {
          if (status.oldExists && !status.newExists) {
            const rb = await this.removeSnapshot(newUid);
            if (isErr(rb)) {
              this.log.error(
                `CRITICAL: Rollback failed for ${newUid} after commit error.`,
                rb.error,
              );
            }
          }
          return commit;
        }

        if (status.oldExists) {
          const rm = await this.removeSnapshot(oldUid);
          if (isErr(rm)) {
            this.log.warn(
              `assignNewId: Succeeded, but failed to clean up old snapshot ${oldUid}.`,
              rm.error,
            );
          }
        }

        return ok(newUid);
      });
    });
  }

  public async createSnapshotFromContent(
    uid: string,
    content: string,
    vaultPath?: string,
  ): Promise<Result<void, NotePersistenceFailure>> {
    return this.createSnapshotCore(null, uid, async () => content, vaultPath);
  }

  public async readSnapshotById(uid: string): Promise<Result<string, AppFailure>> {
    return this.readSnapshot(uid);
  }

  /**
   * Find the most recent backup file for a given target file.
   * Uses the pathHash in the filename to identify backups for the same file.
   */
  private async getLatestBackupForFile(filePath: string): Promise<ParsedBackupEntry | null> {
    const pathHash = getBackupPathHash(filePath);
    const backups = await this.loadAllParsedBackups();
    return backups.find((entry) => entry.parsed.pathHash === pathHash) ?? null;
  }

  public async createBackup(
    targetFile: TFile,
    opts?: { skipIfDuplicate?: boolean; uid?: string },
  ): Promise<Result<boolean, NotePersistenceFailure>> {
    const uid = opts?.uid ?? this.tryGetId(targetFile);
    const backupFileName = generateBackupFileName(targetFile.basename, targetFile.path, uid);
    const backupPath = Pathing.joinVaultPath(this.backupDir, backupFileName);

    const readResult = await this.fs.readVaultTextWithRetry(targetFile);
    if (isErr(readResult)) {
      return err(snapshotErrors.readFailed(`Failed to read for backup`, readResult.error));
    }
    const currentContent = readResult.value;

    // --- DUPLICATE DETECTION LOGIC ---
    if (opts?.skipIfDuplicate) {
      const latestBackup = await this.getLatestBackupForFile(targetFile.path);
      if (latestBackup) {
        const latestContentRes = await this.fs.readVaultText(latestBackup.path);
        if (!isErr(latestContentRes)) {
          // Use existing sha1Hex utility for content comparison
          const currentHash = sha1Hex(currentContent);
          const latestHash = sha1Hex(latestContentRes.value);

          if (currentHash === latestHash) {
            this.log.info(`Skipped backup for ${targetFile.path} (content unchanged).`);
            return ok(false); // false = not created (was duplicate)
          }
        }
      }
    }
    // --- END DUPLICATE DETECTION LOGIC ---

    const writeResult = await notifyOnFsError(
      this.fs.writeVaultTextAtomic(backupPath, currentContent),
      {
        message: "KOReader Importer: Failed to create backup. Check folder permissions.",
        onceKey: "snapshotsWritable",
      },
    );

    if (isErr(writeResult)) {
      return err(snapshotErrors.writeFailed(`Failed to create backup`, writeResult.error));
    }

    this.log.info(`Created backup for ${targetFile.path} at ${backupPath}`);
    return ok(true); // true = created successfully
  }

  public async cleanupOldBackups(
    retentionDays: number,
    maxBackupsPerNote: number,
  ): Promise<Result<void, AppFailure>> {
    const days = Number.isFinite(retentionDays) ? retentionDays : 0;
    const max = Number.isFinite(maxBackupsPerNote) ? maxBackupsPerNote : 0;

    if (days <= 0 && max <= 0) {
      return ok(undefined);
    }

    this.log.info(`Cleaning backups (retention: ${days} days, max per note: ${max})...`);

    // Use walkVaultDirPaths which works with adapter.list() - safe for .obsidian folder
    const filePaths = await this.fs.walkVaultDirPaths(this.backupDir, {
      recursive: true,
      extensions: ["md"],
    });

    if (filePaths.length === 0) {
      return ok(undefined);
    }

    const parsedBackups = await this.parseAndSortBackupFiles(filePaths);
    const pathsToDelete = new Set<string>();
    const metrics = {
      scanned: filePaths.length,
      parsed: parsedBackups.length,
      unparseable: filePaths.length - parsedBackups.length,
      groupedByUid: 0,
      groupedByPathHash: 0,
      agePruned: 0,
      capPruned: 0,
      deleted: 0,
      deleteFailed: 0,
    };

    for (const entry of parsedBackups) {
      if (entry.parsed.uid) metrics.groupedByUid++;
      else metrics.groupedByPathHash++;
    }

    if (metrics.scanned > 0 && metrics.unparseable / metrics.scanned > 0.1) {
      this.log.warn(
        `Backup cleanup parse warning: ${metrics.unparseable}/${metrics.scanned} files were not parseable.`,
      );
    }

    // Age-based cleanup
    if (days > 0) {
      const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
      const oldFiles = parsedBackups.filter((entry) => {
        return entry.parsed.timestamp.getTime() < cutoffTime;
      });
      for (const entry of oldFiles) {
        pathsToDelete.add(entry.path);
        metrics.agePruned++;
      }
    }

    // Per-note limit cleanup
    if (max > 0) {
      const filesByNote = new Map<string, ParsedBackupEntry[]>();

      for (const entry of parsedBackups) {
        const groupKey = backupGroupKey(entry.parsed);
        if (!filesByNote.has(groupKey)) {
          filesByNote.set(groupKey, []);
        }
        filesByNote.get(groupKey)!.push(entry);
      }

      for (const entries of filesByNote.values()) {
        if (entries.length > max) {
          for (const entry of entries.slice(max)) {
            pathsToDelete.add(entry.path);
            metrics.capPruned++;
          }
        }
      }
    }

    if (pathsToDelete.size === 0) {
      return ok(undefined);
    }

    let deletedCount = 0;
    const concurrency = getOptimalConcurrency({ min: 1 });

    const resultsStream = runPool(
      Array.from(pathsToDelete),
      async (path: string) => {
        const removeResult = await this.fs.removeVaultPath(path);
        if (isErr(removeResult)) {
          this.log.warn(`Failed to delete backup: ${path}`, removeResult.error);
        }
        return !isErr(removeResult);
      },
      { concurrency },
    );

    for await (const result of resultsStream) {
      if (result.ok && result.value === true) {
        deletedCount++;
        metrics.deleted++;
      } else if (result.ok && result.value === false) {
        metrics.deleteFailed++;
      }
    }

    this.log.info(`Cleanup complete. Deleted ${deletedCount} backup(s).`);
    this.log.info("Backup cleanup metrics", metrics);
    return ok(undefined);
  }

  public async migrateSingleLegacySnapshot(
    file: TFile,
    uid: string,
  ): Promise<Result<void, NotePersistenceFailure>> {
    const legacyPath = legacySnapshotPathFor(this.snapshotDir, file.path);

    return this.withSnapshotLock(uid, async () => {
      const legacyExistsRes = await this.fs.vaultExists(legacyPath);

      // Treat non-Result or Err as "no legacy snapshot"; avoid passing bad values to isErr.
      if (!legacyExistsRes || isErr(legacyExistsRes) || !legacyExistsRes.value) {
        return ok(undefined);
      }

      // If a snapshot for the UID already exists, just remove legacy and exit.
      if (await this.snapshotExists(uid)) {
        const rm = await this.fs.removeVaultPath(legacyPath);
        if (isErr(rm)) {
          this.log.warn(`Failed to remove legacy snapshot at ${legacyPath}`, rm.error);
        }
        return ok(undefined);
      }

      const readRes = await this.fs.readVaultText(legacyPath);
      if (isErr(readRes)) {
        return err(snapshotErrors.readFailed(`Failed to read legacy snapshot`, readRes.error));
      }

      const writeRes = await this.writeSnapshot(uid, readRes.value);
      if (isErr(writeRes)) {
        return writeRes;
      }

      const rm = await this.fs.removeVaultPath(legacyPath);
      if (isErr(rm)) {
        this.log.warn(`Failed to remove legacy snapshot at ${legacyPath}`, rm.error);
      }

      return ok(undefined);
    });
  }

  private async createSnapshotCore(
    targetFile: TFile | null,
    uid: string,
    contentProvider: () => Promise<string>,
    vaultPath?: string,
  ): Promise<Result<void, NotePersistenceFailure>> {
    if (!uid) {
      return err(snapshotErrors.uidMissing("Cannot create snapshot with empty UID."));
    }

    return this.withSnapshotLock(uid, async () => {
      try {
        const content = await contentProvider();
        const path = vaultPath ?? targetFile?.path;
        return this.writeSnapshot(uid, content, path);
      } catch (e) {
        const path = targetFile?.path ?? `UID ${uid}`;
        this.log.error(`Failed to get content for snapshot of ${path}`, e);
        return err(snapshotErrors.readFailed(`Failed to read content for snapshot of ${path}`, e));
      }
    });
  }

  private async checkMigrationStatus(
    oldUid: string,
    newUid: string,
  ): Promise<{ oldExists: boolean; newExists: boolean }> {
    const [oldExists, newExists] = await Promise.all([
      this.snapshotExists(oldUid),
      this.snapshotExists(newUid),
    ]);
    return { oldExists, newExists };
  }

  private async updateFrontmatterUid(
    file: TFile,
    newUid: string,
  ): Promise<Result<string, AppFailure>> {
    try {
      await this.noteEditorService.editFrontmatter(file, (fm) => {
        const updated = updateUidFrontmatter((fm as Record<string, unknown>) ?? {}, newUid);
        Object.assign(fm, updated);
      });
      return ok(newUid);
    } catch (e) {
      // Type guard for AppFailure
      if (isAppFailure(e)) {
        return err(e);
      }
      // Fallback: wrap unknown error
      return err({
        kind: "WriteFailed",
        path: file.path,
        cause: e,
      } as AppFailure);
    }
  }

  private async writeSnapshot(
    uid: string,
    body: string,
    vaultPath?: string,
  ): Promise<Result<void, NotePersistenceFailure>> {
    const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
    const hash = computeSnapshotHash(body);
    const content = composeSnapshotContent(hash, body, {
      uid,
      vaultPath,
      createdAt: Date.now(),
    });
    const writeResult = await notifyOnFsError(this.fs.writeVaultTextAtomic(path, content), {
      onceKey: "snapshotsWritable",
    });
    return isErr(writeResult)
      ? err(
          snapshotErrors.writeFailed(`Failed to write snapshot for UID ${uid}`, writeResult.error),
        )
      : ok(undefined);
  }

  private async readSnapshot(uid: string): Promise<Result<string, AppFailure>> {
    const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
    const r = await this.fs.readVaultText(path);
    if (isErr(r)) {
      const e = r.error;
      return e?.kind === "NotFound"
        ? err(snapshotErrors.snapshotMissing(`No snapshot at ${path}`))
        : err(snapshotErrors.readFailed(`Failed to read ${path}`, r.error));
    }
    const verifyResult = verifySnapshotIntegrity(r.value, { path });
    if (isErr(verifyResult)) {
      const error = verifyResult.error;
      this.log.warn(`Snapshot integrity check failed for ${path}: ${error.kind}`, error);
    }
    return verifyResult;
  }

  private async removeSnapshot(uid: string): Promise<Result<void, AppFailure>> {
    const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
    const res = await this.fs.removeVaultPath(path);
    return isErr(res)
      ? err(snapshotErrors.writeFailed(`Failed to remove ${path}`, res.error))
      : ok(undefined);
  }

  private async snapshotExists(uid: string): Promise<boolean> {
    const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
    const res = await this.fs.vaultExists(path);

    if (isErr(res)) {
      // NotFound -> no snapshot; other errors logged but treated as "no snapshot"
      if (res.error.kind !== "NotFound") {
        this.log.warn(`Failed to check snapshot existence at ${path}`, res.error);
      }
      return false;
    }

    return Boolean(res.value);
  }

  private withSnapshotLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
    const key = `snapshot:${uid}`;
    return this.queue.run(key, task);
  }

  private async withTwoSnapshotLocks<T>(a: string, b: string, task: () => Promise<T>): Promise<T> {
    const [first, second] = [a, b].sort();
    return this.withSnapshotLock(first, () => this.withSnapshotLock(second, task));
  }

  private async parseAndSortBackupFiles(
    filePaths: string[],
    opts?: { includeSize?: boolean },
  ): Promise<ParsedBackupEntry[]> {
    const entries: ParsedBackupEntry[] = [];
    const includeSize = opts?.includeSize ?? false;

    for (const path of filePaths) {
      const basename = Pathing.vaultBasenameOf(path);
      const parsed = parseBackupFilename(basename);
      if (!parsed) continue;

      let size = 0;
      if (includeSize) {
        // The backups UI is low-frequency and can tolerate content reads for size.
        const contentRes = await this.fs.readVaultText(path);
        size = isErr(contentRes) ? 0 : contentRes.value.length;
      }

      entries.push({ path, basename, size, parsed });
    }

    return entries.sort((a, b) => b.parsed.timestamp.getTime() - a.parsed.timestamp.getTime());
  }

  private async loadAllParsedBackups(opts?: {
    includeSize?: boolean;
  }): Promise<ParsedBackupEntry[]> {
    // Use walkVaultDirPaths which works with adapter.list() - safe for .obsidian folder
    const filePaths = await this.fs.walkVaultDirPaths(this.backupDir, {
      recursive: true,
      extensions: ["md"],
    });
    return this.parseAndSortBackupFiles(filePaths, opts);
  }

  public async createNoteAtomically(params: {
    folderPath: string;
    baseStem: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<
    AppResult<{
      file: TFile;
      uid: string;
      snapshotCreated: boolean;
      warnings?: ImportWarning[];
    }>
  > {
    const { folderPath, baseStem, content, signal } = params;
    signal?.throwIfAborted();

    const createRes = await this.fs.createVaultFileUnique(folderPath, baseStem, content);
    if (isErr(createRes)) return err(createRes.error);
    const { file: targetFile, warnings: initialWarnings } = createRes.value;

    // Lock the newly created file to perform UID, backup, and snapshot operations atomically.
    return this.withFileLock(targetFile, async () => {
      signal?.throwIfAborted();

      const uidResult = await this.ensureId(targetFile);
      if (isErr(uidResult)) return err(uidResult.error);
      const uid = uidResult.value;

      const warnings: ImportWarning[] = [...initialWarnings];
      // For new notes, we don't need duplicate detection since there are no previous backups
      const backupRes = await this.createBackup(targetFile, { uid });
      if (isErr(backupRes)) {
        this.addWarning(warnings, "BACKUP_FAILED", "Backup creation failed for new note.");
      }

      await this.tryCreateSnapshot(
        targetFile,
        uid,
        content,
        warnings,
        "Snapshot creation failed for new note.",
      );

      return this.buildPersistenceResult(targetFile, uid, warnings);
    });
  }

  public async updateNoteAtomically(params: {
    file: TFile;
    updater: NoteUpdater;
    uid?: string;
    signal?: AbortSignal;
  }): Promise<
    AppResult<{
      file: TFile;
      uid: string;
      snapshotCreated: boolean;
      warnings?: ImportWarning[];
    }>
  > {
    const { file: targetFile, updater, signal } = params;
    signal?.throwIfAborted();

    const uidResult = params.uid ? ok(params.uid) : await this.ensureId(targetFile);
    if (isErr(uidResult)) return err(uidResult.error);
    const uid = uidResult.value;

    return this.withFileLock(targetFile, async () => {
      signal?.throwIfAborted();

      const warnings: ImportWarning[] = [];
      const backupRes = await this.createBackup(targetFile, { skipIfDuplicate: true, uid });
      if (isErr(backupRes)) {
        this.addWarning(warnings, "BACKUP_FAILED", "Backup creation failed prior to write.");
      }

      const editRes = await this.noteEditorService.editFile(targetFile, updater, {
        detectConcurrentModification: true,
        skipIfNoChange: true,
        signal,
        afterWrite: async (ctx) => {
          signal?.throwIfAborted();
          await this.tryCreateSnapshot(
            targetFile,
            uid,
            ctx.newContent,
            warnings,
            "Snapshot creation failed after note update.",
          );
        },
      });

      if (isErr(editRes)) return err(editRes.error);

      return this.buildPersistenceResult(targetFile, uid, warnings);
    });
  }

  public async collectOrphanedSnapshots(highlightsFolder: string): Promise<{
    scanned: number;
    deleted: number;
    failed: number;
  }> {
    if (this.isGCRunning) {
      this.log.info("Snapshot GC is already in progress. Skipping concurrent run.");
      return { scanned: 0, deleted: 0, failed: 0 };
    }
    this.isGCRunning = true;
    try {
      // Delegate to the private core implementation
      const result = await this.executeOrphanSweep(highlightsFolder);
      // Reset deletion counter after successful GC
      this.deletionsSinceLastGC = 0;
      return result;
    } finally {
      this.isGCRunning = false;
    }
  }

  /**
   * Get the number of deletions since the last GC run.
   * Used to determine if an immediate GC should be triggered.
   */
  public getDeletionsSinceLastGC(): number {
    return this.deletionsSinceLastGC;
  }

  /**
   * Increment the deletion counter. Called when a note is deleted.
   * This helps trigger GC more frequently when many deletions occur.
   */
  public recordDeletion(): void {
    this.deletionsSinceLastGC++;
  }

  /**
   * Eagerly delete a snapshot if it's confirmed to be orphaned.
   * This is an optimization for the common case of single-note deletions.
   *
   * Strategy:
   * 1. Quick scan of highlights folder using metadata cache (fast, no file I/O)
   * 2. If UID not found in any note, delete the snapshot
   * 3. Fire-and-forget: errors are logged but don't block the caller
   *
   * @param uid - The UID to check and potentially delete
   * @param highlightsFolder - The folder to scan for active notes
   */
  public async deleteSnapshotIfOrphaned(uid: string, highlightsFolder: string): Promise<void> {
    try {
      const isActive = await this.vaultScanner.isUidActive(uid, highlightsFolder);
      if (isActive) {
        this.log.info(`Snapshot ${uid} is not orphaned.`);
        return;
      }

      this.log.info(`Eagerly deleting orphaned snapshot for UID ${uid} (not found in vault)`);

      const deleteResult = await this.removeSnapshot(uid);
      if (isErr(deleteResult)) {
        this.log.warn(`Failed to eagerly delete orphaned snapshot ${uid}`, deleteResult.error);
      } else {
        this.log.info(`Successfully deleted orphaned snapshot ${uid}`);
      }
    } catch (error) {
      // Don't throw - this is a best-effort optimization
      this.log.warn(`Error during eager snapshot deletion for UID ${uid}`, error);
    }
  }

  private async executeOrphanSweep(highlightsFolder: string): Promise<{
    scanned: number;
    deleted: number;
    failed: number;
  }> {
    const summary = { scanned: 0, deleted: 0, failed: 0 };
    this.log.info("Starting orphaned snapshot garbage collection...");

    try {
      const activeUids = await this.vaultScanner.getAllActiveUids(highlightsFolder);
      this.log.info(`Mark phase complete. Found ${activeUids.size} active UIDs.`);

      // --- SWEEP PHASE ---
      const listResult = await this.fs.listVaultDir(this.snapshotDir);
      if (isErr(listResult)) {
        this.log.error("Failed to list snapshot directory during GC", listResult.error);
        return summary; // Abort on failure to list
      }

      const snapshotFiles = listResult.value.files;
      summary.scanned = snapshotFiles.length;

      const orphansToDelete = snapshotFiles.filter((fileName) => {
        if (!fileName.endsWith(".md")) return false;
        const uid = fileName.slice(0, -3); // remove .md
        return validateUid(uid) && !activeUids.has(uid);
      });

      if (orphansToDelete.length === 0) {
        this.log.info("Sweep phase complete. No orphaned snapshots found.");
        return summary;
      }

      this.log.info(`Sweep phase: Found ${orphansToDelete.length} orphaned snapshots to delete.`);

      const concurrency = getOptimalConcurrency({ min: 1, max: 4 });
      const resultsStream = runPool(
        orphansToDelete,
        async (fileName: string) => {
          const fullPath = Pathing.joinVaultPath(this.snapshotDir, fileName);
          const removeResult = await this.fs.removeVaultPath(fullPath);
          if (isErr(removeResult)) {
            this.log.warn(`Failed to delete orphaned snapshot ${fullPath}`, removeResult.error);
            return "failed";
          }
          return "deleted";
        },
        { concurrency },
      );

      for await (const result of resultsStream) {
        if (result.ok) {
          if (result.value === "deleted") summary.deleted++;
          else if (result.value === "failed") summary.failed++;
        }
      }

      this.log.info(
        `Snapshot GC complete. Scanned: ${summary.scanned}, Deleted: ${summary.deleted}, Failed: ${summary.failed}`,
      );
      return summary;
    } catch (error) {
      this.log.error("Failed to scan vault for active UIDs during snapshot GC", error);
      return summary; // Abort on failure to scan
    }
  }

  /**
   * Find all backups for a given file by matching the pathHash in the filename.
   * Returns backups sorted by timestamp (newest first).
   */
  public async getBackupsForFile(file: TFile): Promise<BackupInfo[]> {
    try {
      const pathHash = getBackupPathHash(file.path);
      const backups = await this.loadAllParsedBackups({ includeSize: true });

      return backups
        .filter((entry) => entry.parsed.pathHash === pathHash)
        .map((entry) => {
          const timestamp = entry.parsed.timestamp;
          return {
            path: entry.path,
            basename: entry.basename,
            size: entry.size,
            timestamp,
            formattedTime: timestamp.toLocaleString(),
          };
        });
    } catch (error) {
      this.log.warn(`Error finding backups for file ${file.path}`, error);
      return [];
    }
  }

  /**
   * Restore a note from a backup file.
   * This is a destructive operation that overwrites the current note content.
   *
   * @param file - The target file to restore
   * @param backupPath - The backup file path to restore from (vault-relative)
   * @returns Result indicating success or failure
   */
  public async restoreBackup(file: TFile, backupPath: string): Promise<Result<void, AppFailure>> {
    return this.withFileLock(file, async () => {
      try {
        // Step 1: Create a safety backup of the current state
        const safetyBackupRes = await this.createBackup(file);
        if (isErr(safetyBackupRes)) {
          this.log.warn(`Failed to create safety backup before restore`, safetyBackupRes.error);
          // Continue anyway - the restore is more important than the safety backup
        }

        // Step 2: Read the backup content
        const backupContentRes = await this.fs.readVaultText(backupPath);
        if (isErr(backupContentRes)) {
          return err(toFailure(backupContentRes.error, backupPath, "ReadFailed"));
        }

        // Step 3: Replace the file content atomically
        const writeRes = await this.fs.writeVaultTextAtomic(file.path, backupContentRes.value);
        if (isErr(writeRes)) {
          return err(toFailure(writeRes.error, file.path, "WriteFailed"));
        }

        // Step 4: CRITICAL - Reset the 3-way merge baseline to the restored content
        const uid = this.tryGetId(file);
        if (uid) {
          const snapshotRes = await this.createSnapshotFromContent(
            uid,
            backupContentRes.value,
            file.path,
          );
          if (isErr(snapshotRes)) {
            this.log.warn(`Failed to reset snapshot after restore`, snapshotRes.error);
            // Don't fail the restore operation, but log the warning
          }
        }

        this.log.info(`Successfully restored ${file.path} from backup ${backupPath}`);
        return ok(undefined);
      } catch (error) {
        this.log.error(`Failed to restore backup for ${file.path}`, error);
        return err(toFailure(error, file.path, "WriteFailed"));
      }
    });
  }
}
