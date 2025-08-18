import type { App, FrontMatterCache, TFile, TFolder } from "obsidian";
import { KeyedQueue } from "src/lib/concurrency/concurrency";
import { isErr } from "src/lib/core/result";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
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

	private readonly log;
	// Optional snapshot manager reference, set by SnapshotManager to avoid DI cycles
	private snapshot?: SnapshotManager;
	// Serialize operations per file to prevent overlapping UID reassignments
	private readonly fileQueue = new KeyedQueue();

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
	 * Returns the existing or newly created UID.
	 */
	public async ensureId(file: TFile): Promise<string> {
		const existingUid = this.tryGetId(file);
		if (this.isValidUid(existingUid)) {
			return existingUid!;
		}
		// UID is missing or invalid, assign a new one.
		return this.assignNewId(file);
	}

	/**
	 * Force-assigns a brand new UID, replacing any existing value.
	 * Two-phase flow: prepare (snapshot) -> commit (frontmatter) -> publish (event).
	 * Serialized per-file to avoid overlapping operations.
	 */
	public async assignNewId(file: TFile): Promise<string> {
		return this.fileQueue.run(`nid:${file.path}`, async () => {
			const oldUid = this.tryGetId(file) ?? null;
			const newUid = this.generateUid();

			// Build patched content once (in-memory): new UID + prev list cleanup
			const readRes = await this.fs.readVaultTextWithRetry(file);
			if (isErr(readRes)) {
				this.log.error("Failed to read file while assigning UID", {
					file: file.path,
					error: (readRes as any).error ?? readRes,
				});
				throw (
					(readRes as any).error ?? new Error("readVaultTextWithRetry failed")
				);
			}
			const currentContent = readRes.value;
			const { frontmatter, body } = this.fmService.parseContent(currentContent);
			(frontmatter as any)[NoteIdentityService.UID_KEY] = newUid;
			try {
				const prevRaw = (frontmatter as any)["kohl-prev-uids"];
				const prevArr: string[] = Array.isArray(prevRaw)
					? prevRaw.filter((x: any) => typeof x === "string" && x.trim())
					: typeof prevRaw === "string" && prevRaw.trim()
						? [prevRaw.trim()]
						: [];
				const merged = [...prevArr, ...(oldUid ? [oldUid] : [])];
				(frontmatter as any)["kohl-prev-uids"] = Array.from(
					new Set(merged),
				).slice(-5);
			} catch {
				/* best-effort */
			}
			for (const key in frontmatter as any) {
				if (
					Object.hasOwn(frontmatter as any, key) &&
					key.includes("kohl-uid") &&
					key !== NoteIdentityService.UID_KEY
				) {
					delete (frontmatter as any)[key];
				}
			}
			const patchedContent = this.fmService.reconstructFileContent(
				frontmatter as any,
				body,
			);

			// 1) Prepare: snapshot-first using the patched content; abort if it fails
			let snapshotPrepared = false;
			if (this.snapshot) {
				const res = await this.snapshot.createSnapshotFromContent(
					file,
					patchedContent,
					newUid,
				);
				if (isErr(res)) {
					this.log.warn("Snapshot write before UID change failed", {
						file: file.path,
						error: (res as any).error ?? res,
					});
					throw new Error(
						"Failed to prepare snapshot for new UID; aborting UID change",
					);
				}
				snapshotPrepared = true;
			} else {
				this.log.warn(
					"SnapshotManager is not set; proceeding without snapshot-first.",
				);
			}

			// 2) Commit: write the same patched content; rollback snapshot on failure
			try {
				await this.fmService.overwriteFile(file, patchedContent);
			} catch (e) {
				if (snapshotPrepared) {
					try {
						await this.snapshot?.removeSnapshotById?.(newUid);
					} catch {
						/* best-effort */
					}
				}
				this.log.error("Failed to overwrite file while assigning UID", {
					file: file.path,
					error: e,
				});
				throw new Error(`Failed to assign new UID to ${file.path}`);
			}

			// 3) Cleanup: best-effort removal of the old snapshot.
			// The new snapshot is guaranteed to exist at this point (snapshot-first).
			if (oldUid && this.snapshot) {
				const cleanupRes = await this.snapshot.removeSnapshotById(oldUid);
				if (isErr(cleanupRes)) {
					this.log.warn(`Failed to clean up old snapshot for ${oldUid}`, {
						file: file.path,
						error: cleanupRes.error,
					});
				}
			}
			return newUid;
		});
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
					try {
						await this.assignNewId(f);
						summary.filesReassigned++;
						reassignedPaths.push(f.path);
					} catch (e) {
						this.log.error(`Failed to reassign UID for ${f.path}`, e);
					}
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
