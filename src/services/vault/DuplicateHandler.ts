import { type App, Notice, type TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type {
	DuplicateChoice,
	DuplicateMatch,
	IDuplicateHandlingModal,
} from "src/types";
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
	private readonly SCOPE = "DuplicateHandler";
	private applyToAll = false;
	private applyToAllChoice: DuplicateChoice | null = null;
	private modalLock: Promise<void> = Promise.resolve();

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private modalFactory: (
			app: App,
			match: DuplicateMatch,
			message: string,
		) => IDuplicateHandlingModal,
		private mergeService: MergeService,
		private snapshotManager: SnapshotManager,
		private fsService: FileSystemService,
		private loggingService: LoggingService,
	) {}

	public reset() {
		this.applyToAll = false;
		this.applyToAllChoice = null;
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
	): Promise<{ status: ResolveStatus; file: TFile | null }> {
		const autoMergeEnabled = this.plugin.settings.autoMergeOnAddition;
		const isUpdateOnly =
			analysis.matchType === "updated" && analysis.modifiedHighlights === 0;

		// Condition for auto-merging
		if (autoMergeEnabled && isUpdateOnly && analysis.canMergeSafely) {
			this.loggingService.info(
				this.SCOPE,
				`Auto-merging additions into ${analysis.file.path}`,
			);
			const newContent = await contentProvider();
			await this.mergeService.execute3WayMerge(
				analysis.file,
				(await this.snapshotManager.getSnapshotContent(analysis.file))!,
				newContent,
				analysis.luaMetadata,
			);
			return { status: "automerged", file: analysis.file };
		}

		const choice = await this.promptUser(analysis);

		switch (choice) {
			case "replace": {
				const newContent = await contentProvider();
				await this.snapshotManager.createBackup(analysis.file);
				await this.app.vault.modify(analysis.file, newContent);
				return { status: "merged", file: analysis.file };
			}
			case "merge": {
				const baseContent = await this.snapshotManager.getSnapshotContent(
					analysis.file,
				);

				if (!baseContent) {
					this.loggingService.error(
						this.SCOPE,
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
			case "skip":
			default:
				return { status: "skipped", file: null };
		}
	}

	private async promptUser(analysis: DuplicateMatch): Promise<DuplicateChoice> {
		let unlock: () => void;
		const lock = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const prev = this.modalLock;
		this.modalLock = prev.then(() => lock);

		try {
			await prev;

			if (this.applyToAll && this.applyToAllChoice) {
				return this.applyToAllChoice;
			}

			const modal = this.modalFactory(
				this.app,
				analysis,
				"Duplicate detected – choose an action",
			);
			const res = await modal.openAndGetChoice();
			const choice = res.choice ?? "skip";

			if (!this.applyToAll && res.applyToAll) {
				this.applyToAll = true;
				this.applyToAllChoice = choice;
			}

			return choice;
		} finally {
			unlock!();
		}
	}
}
