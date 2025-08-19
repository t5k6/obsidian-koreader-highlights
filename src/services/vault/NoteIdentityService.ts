import type { App, FrontMatterCache, TFile, TFolder } from "obsidian";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { AppFailure } from "src/lib/errors/resultTypes";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type {
    FrontmatterService,
    NoteDoc,
    NoteUpdater,
} from "src/services/parsing/FrontmatterService";
import type { SnapshotManager } from "./SnapshotManager";

export type UidCollisionSummary = {
	scanned: number;
	withUid: number;
	uniqueUids: number;
	collisions: number;
	filesReassigned: number;
	details: Array<{ uid: string; kept: string; reassigned: string[] }>;
};

export class NoteIdentityService {
    public static readonly UID_KEY = "kohl-uid" as const;
    public static readonly PREV_UIDS_KEY = "kohl-prev-uids" as const;

    private readonly log;
    // Optional snapshot manager reference, set by SnapshotManager to avoid DI cycles
    private snapshot?: SnapshotManager;

    constructor(
        private readonly app: App,
        private readonly fmService: FrontmatterService,
        private readonly loggingService: LoggingService,
        private readonly fs: FileSystemService,
    ) {
        this.log = this.loggingService.scoped("NoteIdentityService");
    }

    /** Wire-in SnapshotManager after construction to avoid DI cycles. */
    public setSnapshotManager(sm: SnapshotManager) {
        this.snapshot = sm;
    }

    /**
     * Returns the UID from Obsidian's in-memory metadata cache, if present.
     * Never performs I/O. Returns undefined if not present in cache.
     */
    public tryGetId(file: TFile): string | undefined {
        const fm: FrontMatterCache | undefined =
            this.app.metadataCache.getFileCache(file)?.frontmatter;
        const raw = fm?.[NoteIdentityService.UID_KEY];
        return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    }

    /**
     * Ensures that the given file has a UID. If missing, writes one to frontmatter.
     * Returns the existing or newly created UID. Throws on failure for compatibility.
     */
    public async ensureId(file: TFile): Promise<string> {
        const existingUid = this.tryGetId(file);
        if (this.isValidUid(existingUid)) {
            return existingUid!;
        }
        // UID is missing or invalid, assign a new one via Result and unwrap.
        const result = await this.assignNewId(file);
        if (isErr(result)) {
            throw new Error(`Failed to ensure ID for ${file.path}`, {
                cause: result.error,
            });
        }
        return result.value;
    }

    /**
     * Force-assigns a brand new UID, replacing any existing value.
     * Delegates the RMW lifecycle to FrontmatterService.editFile with transactional hooks.
     * Returns a Result so callers can handle failures gracefully.
     */
    public async assignNewId(
        file: TFile,
    ): Promise<Result<string, AppFailure>> {
        const newUid = this.generateUid();
        let oldUid: string | undefined;

        const updater: NoteUpdater = (doc: NoteDoc) => {
            const fm = { ...doc.frontmatter } as Record<string, unknown>;
            // Read old UID from cache to avoid I/O; if missing, we still proceed.
            oldUid = this.tryGetId(file);

            // 1) Set new UID
            (fm as any)[NoteIdentityService.UID_KEY] = newUid;

            // 2) Maintain history of previous UIDs
            const prevRaw = (fm as any)[NoteIdentityService.PREV_UIDS_KEY];
            const prevArr = Array.isArray(prevRaw)
                ? prevRaw.filter((x: unknown): x is string =>
                      typeof x === "string" && !!x.trim(),
                  )
                : [];
            const merged = [
                ...new Set([
                    ...prevArr,
                    ...(oldUid ? [oldUid] : []),
                ]),
            ].slice(-5);
            if (merged.length > 0) {
                (fm as any)[NoteIdentityService.PREV_UIDS_KEY] = merged;
            } else {
                // Remove the key if no history to keep the YAML clean
                delete (fm as any)[NoteIdentityService.PREV_UIDS_KEY];
            }

            // 3) Clean up any other stray kohl-uid keys
            for (const key in fm) {
                if (
                    Object.prototype.hasOwnProperty.call(fm, key) &&
                    key.includes("kohl-uid") &&
                    key !== NoteIdentityService.UID_KEY
                ) {
                    delete (fm as any)[key];
                }
            }
            return { frontmatter: fm, body: doc.body };
        };

        const editResult = await this.fmService.editFile(file, updater, {
            detectConcurrentModification: true,
            beforeWrite: async (ctx) => {
                if (!this.snapshot) return ok(void 0);
                const snapResult = await this.snapshot.createSnapshotFromContent(
                    ctx.file,
                    ctx.newContent,
                    newUid,
                );
                if (isErr(snapResult)) {
                    // Map to AppFailure for FrontmatterService contract
                    return err({
                        kind: "WriteFailed",
                        path: ctx.file.path,
                        cause: snapResult.error,
                    });
                }
                return ok(void 0);
            },
            afterWrite: async () => {
                if (oldUid && this.snapshot) {
                    // Best-effort cleanup of old snapshot
                    try {
                        await this.snapshot.removeSnapshotById(oldUid);
                    } catch (e) {
                        this.log.warn(
                            `Failed best-effort cleanup of old snapshot ${oldUid}`,
                            e,
                        );
                    }
                }
            },
        });

        if (isErr(editResult)) {
            // Rollback: remove the new snapshot if it was created but write failed
            if (this.snapshot) {
                try {
                    await this.snapshot.removeSnapshotById(newUid);
                } catch {
                    // best-effort
                }
            }
            this.log.error(`Failed to assign new UID to ${file.path}`, editResult.error);
            return err(editResult.error);
        }

        return ok(newUid);
    }

    public generateUid(): string {
        try {
            const g: any = globalThis as any;
            if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
            this.log.error("crypto.randomUUID is not available in this environment");
            throw new Error("crypto.randomUUID not available");
        } catch (e) {
            this.log.error("Failed to generate UID", e);
            throw e;
        }
    }

    /**
     * Scan a vault folder for duplicate kohl-uid values and reassign new UIDs
     * to all but the oldest file for each collision set.
     */
    public async resolveInFolder(
        folder: string | TFolder,
        opts?: { recursive?: boolean },
    ): Promise<UidCollisionSummary> {
        const recursive = opts?.recursive ?? true;
        const summary: UidCollisionSummary = {
            scanned: 0,
            withUid: 0,
            uniqueUids: 0,
            collisions: 0,
            filesReassigned: 0,
            details: [],
        };

        const files = await this.fs.listMarkdownFiles(folder, { recursive });
        summary.scanned = files.length;
        if (!files.length) return summary;

        // Build UID map using metadata cache (fast, no file I/O)
        const byUid = new Map<string, TFile[]>();
        for (const f of files) {
            const uid = this.tryGetId(f);
            if (!uid) continue;
            summary.withUid++;
            const arr = byUid.get(uid) ?? [];
            arr.push(f);
            byUid.set(uid, arr);
        }

        summary.uniqueUids = byUid.size;

        for (const [uid, arr] of byUid.entries()) {
            if (arr.length <= 1) continue;

            // Keep oldest by ctime, reassign others
            arr.sort((a, b) => a.stat.ctime - b.stat.ctime);
            const keep = arr[0];
            const toReassign = arr.slice(1);
            summary.collisions++;

            const reassignedPaths: string[] = [];
            await Promise.all(
                toReassign.map(async (f) => {
                    const r = await this.assignNewId(f);
                    if (isErr(r)) {
                        this.log.error(`Failed to reassign UID for ${f.path}`, r.error);
                        return;
                    }
                    summary.filesReassigned++;
                    reassignedPaths.push(f.path);
                }),
            );

            summary.details.push({
                uid,
                kept: keep.path,
                reassigned: reassignedPaths,
            });
        }

        return summary;
    }

	private isValidUid(s?: string): s is string {
		return (
			!!s &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				s,
			)
		);
	}
}
