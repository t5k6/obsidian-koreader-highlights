import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import { KeyedQueue } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { SnapshotError } from "src/lib/errors/resultTypes";
import type KoreaderImporterPlugin from "src/main";
import type { CapabilityManager } from "src/services/CapabilityManager";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type {
	DuplicateChoice,
	DuplicateHandlingSession,
	DuplicateMatch,
	IDuplicateHandlingModal,
} from "src/types";
import type { MergeService } from "./MergeService";
import type { NoteIdentityService } from "./NoteIdentityService";
import type { SnapshotManager } from "./SnapshotManager";

export interface PrepareReady {
	uid: string;
	/** The base content from the snapshot, or null if no snapshot exists (perform a 2-way merge). */
	baseContent: string | null;
	mtime: number;
	size: number;
}

export class MergeHandler {
	private readonly log;
	private readonly modalQueue = new KeyedQueue();

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private modalFactory: (
			app: App,
			match: DuplicateMatch,
			message: string,
			session: DuplicateHandlingSession,
		) => IDuplicateHandlingModal,
		private mergeService: MergeService,
		private snapshotManager: SnapshotManager,
		private fs: FileSystemService,
		private loggingService: LoggingService,
		private capabilities: CapabilityManager,
		private identity: NoteIdentityService,
	) {
		this.log = this.loggingService.scoped("MergeHandler");
	}

	/**
	 * Unifies duplicate handling and merge preparation into a single workflow.
	 */
	public async handleDuplicate(
		analysis: DuplicateMatch,
		bodyProvider: () => Promise<string>,
		session: DuplicateHandlingSession,
		message?: string,
	): Promise<{
		status: "created" | "merged" | "automerged" | "skipped" | "keep-both";
		file: TFile | null;
	}> {
		const autoMergeEnabled = this.plugin.settings.autoMergeOnAddition;
		const isUpdateOnly =
			analysis.matchType === "updated" && analysis.modifiedHighlights === 0;

		// Auto-merge path
		if (autoMergeEnabled && isUpdateOnly && analysis.canMergeSafely) {
			this.log.info(`Auto-merging additions into ${analysis.file.path}`);
			const newBody = await bodyProvider();
			const prep = await this._prepareMerge(analysis.file, {
				expectedUid: analysis.expectedUid,
			});
			if (isErr(prep)) {
				this.log.warn(
					"Automerge preflight failed; skipping automerge",
					prep.error,
				);
				new Notice("Auto-merge skipped: snapshot/baseline unavailable.", 5000);
			} else if (prep.value.baseContent == null) {
				// No baseline available; perform safe 2-way merge to preserve user's edits
				await this.mergeService.execute2WayMerge(
					analysis.file,
					analysis.luaMetadata,
				);
				return { status: "automerged", file: analysis.file };
			} else {
				await this.mergeService.execute3WayMerge(
					analysis.file,
					prep.value.baseContent!,
					newBody,
					analysis.luaMetadata,
				);
				return { status: "automerged", file: analysis.file };
			}
		}

		const choice = await this.promptUser(
			analysis,
			session,
			message ?? "Duplicate detected – choose an action",
		);

		switch (choice) {
			case "replace": {
				const newBody = await bodyProvider();
				try {
					await this.mergeService.replaceWithBody(
						analysis.file,
						newBody,
						analysis.luaMetadata,
					);
					return { status: "merged", file: analysis.file };
				} catch (e) {
					new Notice(
						"Replace failed: unable to write file. Check vault permissions.",
						7000,
					);
					this.log.error("ReplaceWithBody failure", e);
					return { status: "skipped", file: null };
				}
			}
			case "merge": {
				// Gate by centralized capability manager
				const canWrite = await this.capabilities.ensure("snapshotsWritable", {
					notifyOnce: true,
				});
				if (!canWrite) {
					new Notice(
						"Merge failed: Cannot write backup/snapshot file. (Read-only vault or sandbox restriction)",
						7000,
					);
					this.log.warn("Merge aborted: snapshotsWritable is false.");
					return { status: "skipped", file: null };
				}

				const prep = await this._prepareMerge(analysis.file, {
					expectedUid: analysis.expectedUid,
				});
				if (isErr(prep)) {
					this.log.error("Merge preflight failed", prep.error);
					new Notice("Merge failed: preflight failed.", 7000);
					return { status: "skipped", file: null };
				}

				const newBody = await bodyProvider();
				if (prep.value.baseContent == null) {
					// Fallback to 2-way merge when no snapshot exists
					await this.mergeService.execute2WayMerge(
						analysis.file,
						analysis.luaMetadata,
					);
					return { status: "merged", file: analysis.file };
				}
				await this.mergeService.execute3WayMerge(
					analysis.file,
					prep.value.baseContent,
					newBody,
					analysis.luaMetadata,
				);
				return { status: "merged", file: analysis.file };
			}
			case "keep-both":
				return { status: "keep-both", file: null }; // Signal to ImportManager to create a new file
			default:
				return { status: "skipped", file: null };
		}
	}

	private async promptUser(
		analysis: DuplicateMatch,
		session: DuplicateHandlingSession,
		message: string,
	): Promise<DuplicateChoice> {
		// Wrap the entire prompt logic in the keyed queue.
		// The key "duplicate-modal" ensures all calls are serialized.
		return this.modalQueue.run("duplicate-modal", async () => {
			// Re-check the session *after* acquiring the lock. This is the core of the fix.
			if (session.applyToAll && session.choice) {
				return session.choice;
			}

			const modal = this.modalFactory(this.app, analysis, message, session);
			const res = await modal.openAndGetChoice();

			// The choice is now guaranteed to be 'skip' on Esc, thanks to Recommendation 2
			const choice = res.choice ?? "skip";

			// If the user checked "Apply to all" in this modal, update the session
			if (!session.applyToAll && res.applyToAll) {
				session.applyToAll = true;
				session.choice = choice;
			}
			return choice;
		});
	}

	// Consolidated preflight prepare
	private async _prepareMerge(
		file: TFile,
		opts: { expectedUid?: string } = {},
	): Promise<Result<PrepareReady, SnapshotError>> {
		try {
			const uid = await this.identity.ensureId(file);
			if (opts.expectedUid && opts.expectedUid !== uid) {
				return err({
					kind: "UID_MISMATCH",
					message: `Expected UID ${opts.expectedUid} but found ${uid}`,
				});
			}

			let baseContent: string | null = null;
			const snapRes = await this.snapshotManager.readSnapshotById(uid);
			if (isErr(snapRes)) {
				const k = (snapRes.error as any)?.kind;
				if (k === "NotFound" || k === "SNAPSHOT_MISSING") {
					// Do NOT create a baseline here. Signal 2-way merge by returning baseContent: null.
					this.log.info(
						`No snapshot for UID ${uid}. Proceeding without baseline (2-way merge fallback).`,
					);
					baseContent = null;
				} else {
					this.log.warn("readSnapshotById failed", snapRes.error);
					return err({
						kind: "READ_FAILED",
						message: "Snapshot read failed",
						cause: snapRes.error,
					});
				}
			} else {
				baseContent = snapRes.value;
			}

			await this.snapshotManager.createBackup(file);
			const { mtime, size } = file.stat;

			return ok({ uid, baseContent, mtime, size });
		} catch (e) {
			this.log.error("_prepareMerge unexpected failure", e);
			return err({ kind: "READ_FAILED", message: "Prepare failed", cause: e });
		}
	}
}
