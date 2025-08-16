import { type App, Notice, type TFile } from "obsidian";
import { Mutex } from "src/lib/concurrency/concurrency";
import type KoreaderImporterPlugin from "src/main";
import type {
	DuplicateChoice,
	DuplicateHandlingSession,
	DuplicateMatch,
	IDuplicateHandlingModal,
} from "src/types";
import type { CapabilityManager } from "../CapabilityManager";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { MergeService } from "./MergeService";
import type { SnapshotManager } from "./SnapshotManager";

type ResolveStatus =
	| "created"
	| "merged"
	| "automerged"
	| "skipped"
	| "keep-both";

export class DuplicateHandler {
	private readonly log;
	private readonly modalMutex = new Mutex();

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
		_fsService: FileSystemService,
		private loggingService: LoggingService,
		private capabilities: CapabilityManager,
	) {
		this.log = this.loggingService.scoped("DuplicateHandler");
	}

	/**
	 * Handles duplicate resolution by prompting user or applying auto-merge.
	 * Manages modal locking to prevent concurrent duplicate prompts.
	 * @param analysis - The duplicate analysis results
	 * @param contentProvider - Function to generate new content
	 * @returns The user's choice and resulting file
	 */
	public async handleDuplicate(
		analysis: DuplicateMatch,
		contentProvider: () => Promise<string>,
		session: DuplicateHandlingSession,
		message?: string,
	): Promise<{ status: ResolveStatus; file: TFile | null }> {
		const autoMergeEnabled = this.plugin.settings.autoMergeOnAddition;
		const isUpdateOnly =
			analysis.matchType === "updated" && analysis.modifiedHighlights === 0;

		// Condition for auto-merging
		if (autoMergeEnabled && isUpdateOnly && analysis.canMergeSafely) {
			this.log.info(`Auto-merging additions into ${analysis.file.path}`);
			const newContent = await contentProvider();
			await this.mergeService.execute3WayMerge(
				analysis.file,
				(await this.snapshotManager.getSnapshotContent(analysis.file))!,
				newContent,
				analysis.luaMetadata,
			);
			return { status: "automerged", file: analysis.file };
		}

		const choice = await this.promptUser(
			analysis,
			session,
			message ?? "Duplicate detected – choose an action",
		);

		switch (choice) {
			case "replace": {
				const newContent = await contentProvider();
				await this.snapshotManager.createBackup(analysis.file);
				await this.app.vault.modify(analysis.file, newContent);
				return { status: "merged", file: analysis.file };
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

				const baseContent = await this.snapshotManager.getSnapshotContent(
					analysis.file,
				);

				if (!baseContent) {
					this.log.error(
						"UI allowed a merge choice but no snapshot was found. This should not happen. Aborting merge.",
						analysis,
					);
					new Notice(
						"Merge failed: could not find the previous version's snapshot.",
						7000,
					);
					return { status: "skipped", file: null };
				}

				const newContent = await contentProvider();
				await this.mergeService.execute3WayMerge(
					analysis.file,
					baseContent,
					newContent,
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
		return this.modalMutex.lock(async () => {
			if (session.applyToAll && session.choice) return session.choice;

			const modal = this.modalFactory(this.app, analysis, message, session);
			const res = await modal.openAndGetChoice();
			const choice = res.choice ?? "skip";

			if (!session.applyToAll && res.applyToAll) {
				session.applyToAll = true;
				session.choice = choice;
			}
			return choice;
		});
	}
}
