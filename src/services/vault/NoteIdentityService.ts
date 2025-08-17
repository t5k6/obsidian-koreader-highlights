import type { App, FrontMatterCache, TFile, TFolder } from "obsidian";
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

/**
 * Manages stable note identities via a frontmatter UID field (kohl-uid).
 * - tryGetId: fast, synchronous read from metadata cache only
 * - ensureId: asynchronous; writes a UID to frontmatter if missing and returns it
 * - assignNewId: force-assign a brand new UID and return it; emits change
 * - onUidChanged: subscribe to UID-change events
 */
export class NoteIdentityService {
	public static readonly UID_KEY = "kohl-uid" as const;

	private readonly log;
	private listeners: Array<
		(file: TFile, oldUid: string | null, newUid: string) => void
	> = [];
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
	 * Emits a UID-change event.
	 */
	public async assignNewId(file: TFile): Promise<string> {
		const oldUid = this.tryGetId(file) ?? null;
		const newUid = this.generateUid();

		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				// Set the new, correct key. Obsidian's processor will handle it correctly.
				fm[NoteIdentityService.UID_KEY] = newUid;

				// Proactively clean up any malformed keys from development testing.
				for (const key in fm) {
					if (key.includes("kohl-uid") && key !== NoteIdentityService.UID_KEY) {
						delete fm[key];
					}
				}
			});

			// Eagerly create a new snapshot for the new UID (best-effort, but awaited)
			try {
				if (this.snapshot) {
					const content = await this.app.vault.read(file);
					await this.snapshot.createSnapshotFromContent(file, content, newUid);
				}
			} catch (e) {
				// Log but don't fail UID assignment
				this.log.warn("Failed to write new snapshot after UID change", {
					file: file.path,
					error: e,
				});
			}

			this.emitUidChanged(file, oldUid, newUid);
			return newUid;
		} catch (e) {
			this.log.error("Failed to process frontmatter while assigning UID", {
				file: file.path,
				error: e,
			});
			throw new Error(`Failed to assign new UID to ${file.path}`);
		}
	}

	/** Subscribe to UID changes (assignment or reassignment). */
	public onUidChanged(
		listener: (file: TFile, oldUid: string | null, newUid: string) => void,
	): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	private emitUidChanged(
		file: TFile,
		oldUid: string | null,
		newUid: string,
	): void {
		for (const l of this.listeners) {
			try {
				l(file, oldUid, newUid);
			} catch (e) {
				this.log.warn("UID change listener threw", e);
			}
		}
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
