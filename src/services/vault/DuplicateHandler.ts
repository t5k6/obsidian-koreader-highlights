import { type App, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type {
	Annotation,
	DocProps,
	DuplicateChoice,
	DuplicateMatch,
	IDuplicateHandlingModal,
	LuaMetadata,
} from "src/types";
import { ConfirmModal } from "src/ui/ConfirmModal";
import type { CacheManager } from "src/utils/cache/CacheManager";
import { getFileNameWithoutExt } from "src/utils/formatUtils";
import { extractHighlights } from "src/utils/highlightExtractor";
import { getFrontmatterAndBody } from "src/utils/obsidianUtils";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { FileNameGenerator } from "./FileNameGenerator";
import type { LocalIndexService } from "./LocalIndexService";
import type { MergeService } from "./MergeService";
import type { SnapshotManager } from "./SnapshotManager";

type ResolveStatus = "created" | "merged" | "automerged" | "skipped";

export class DuplicateHandler {
	private readonly SCOPE = "DuplicateHandler";
	currentMatch: NonNullable<DuplicateMatch> | null = null;
	public applyToAll = false;
	public applyToAllChoice: DuplicateChoice | null = null;
	private modalLock: Promise<void> = Promise.resolve();
	private potentialDuplicatesCache: Map<string, TFile[]>;

	constructor(
		private app: App,
		private modalFactory: (
			app: App,
			match: DuplicateMatch,
			message: string,
		) => IDuplicateHandlingModal,
		private plugin: KoreaderImporterPlugin,
		private localIndexService: LocalIndexService,
		private snapshotManager: SnapshotManager,
		private mergeService: MergeService,
		private cacheManager: CacheManager,
		private fs: FileSystemService,
		private loggingService: LoggingService,
		private fileNameGenerator: FileNameGenerator,
	) {
		this.potentialDuplicatesCache = cacheManager.createMap(
			"duplicate.potential",
		);
	}

	/**
	 * Resets the "Apply to All" state.
	 * Should be called before starting a new batch import to ensure
	 * each import session starts with fresh duplicate handling choices.
	 */
	public resetApplyToAll(): void {
		this.applyToAll = false;
		this.applyToAllChoice = null;
		this.currentMatch = null;
		this.loggingService.info(this.SCOPE, "'Apply to All' state reset.");
	}

	/**
	 * Clears the internal cache of potential duplicates.
	 * Frees memory and ensures fresh duplicate detection on next run.
	 */
	public clearCache(): void {
		this.potentialDuplicatesCache.clear();
		this.loggingService.info(this.SCOPE, "potential duplicates cache cleared.");
	}

	/**
	 * Primary entry point for handling a potential new book import.
	 * Finds duplicates, decides on a course of action (including auto-merge),
	 * and returns the final status and file.
	 * @param luaMetadata - The metadata from KOReader containing annotations
	 * @param contentProvider - Lazy function to generate file content when needed
	 * @returns Object with status (created/merged/automerged/skipped) and file reference
	 */
	public async resolveDuplicate(
		luaMetadata: LuaMetadata,
		contentProvider: () => Promise<string>,
	): Promise<{ status: ResolveStatus; file: TFile | null }> {
		const potentialDuplicates = await this.findPotentialDuplicates(
			luaMetadata.docProps,
		);

		if (potentialDuplicates.length === 0) {
			return this.createNewFile(luaMetadata, contentProvider);
		}

		const analyses: DuplicateMatch[] = await Promise.all(
			potentialDuplicates.map((file) =>
				this.analyzeDuplicate(file, luaMetadata.annotations, luaMetadata),
			),
		);
		analyses.sort(
			(a, b) =>
				a.newHighlights +
				a.modifiedHighlights -
				(b.newHighlights + b.modifiedHighlights),
		);
		const bestMatch = analyses[0];

		const snapshotExists = await this.snapshotManager.getSnapshotContent(
			bestMatch.file,
		);
		const autoMergeEnabled = this.plugin.settings.autoMergeOnAddition;
		const isUpdateOnly =
			bestMatch.matchType === "updated" && bestMatch.modifiedHighlights === 0;

		if (autoMergeEnabled && isUpdateOnly && snapshotExists) {
			this.loggingService.info(
				this.SCOPE,
				`Auto-merging additions into ${bestMatch.file.path} via safe 3-way merge.`,
			);
			const { file } = await this.handleDuplicate(
				bestMatch,
				contentProvider,
				true,
			);
			return { status: file ? "automerged" : "skipped", file };
		}

		if (autoMergeEnabled && isUpdateOnly && !snapshotExists) {
			this.loggingService.info(
				this.SCOPE,
				`Skipping auto-merge for ${bestMatch.file.path} because no snapshot exists. Prompting user.`,
			);
		}

		const { choice, file } = await this.handleDuplicate(
			bestMatch,
			contentProvider,
			false,
		);

		switch (choice) {
			case "merge":
			case "replace":
				return { status: "merged", file };
			case "automerge":
				return { status: "automerged", file };
			case "skip":
				return { status: "skipped", file: null };
			case "keep-both":
				return this.createNewFile(luaMetadata, contentProvider);
			default:
				this.loggingService.warn(this.SCOPE, `Unhandled choice: ${choice}`);
				return { status: "skipped", file: null };
		}
	}

	/**
	 * Finds existing files in the vault that may be duplicates of the book.
	 * Uses database index for efficient lookup by book key.
	 * @param docProps - Document properties containing title and authors
	 * @returns Array of TFile objects that match the book key
	 */
	public async findPotentialDuplicates(docProps: DocProps): Promise<TFile[]> {
		const bookKey = this.localIndexService.bookKeyFromDocProps(docProps);
		if (this.potentialDuplicatesCache.has(bookKey)) {
			this.loggingService.info(
				this.SCOPE,
				`Cache hit for potential duplicates of key: ${bookKey}`,
			);
			return this.potentialDuplicatesCache.get(bookKey)!;
		}

		this.loggingService.info(
			this.SCOPE,
			`Querying index for existing files with book key: ${bookKey}`,
		);
		const paths = await this.localIndexService.findExistingBookFiles(bookKey);

		const files = paths
			.map((p) => this.app.vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f instanceof TFile);

		this.loggingService.info(
			this.SCOPE,
			`Found ${files.length} potential duplicate(s) for key: ${bookKey}`,
		);
		this.potentialDuplicatesCache.set(bookKey, files);
		return files;
	}

	/**
	 * Analyzes an existing file to determine how it differs from new annotations.
	 * Counts new and modified highlights to classify the duplicate type.
	 * @param existingFile - The existing file to analyze
	 * @param newAnnotations - New annotations from KOReader
	 * @param luaMetadata - Complete metadata for the new import
	 * @returns DuplicateMatch object with analysis results
	 */
	public async analyzeDuplicate(
		existingFile: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		this.loggingService.info(
			this.SCOPE,
			`Analyzing duplicate content: ${existingFile.path}`,
		);
		const { body: existingBody } = await getFrontmatterAndBody(
			this.app,
			existingFile,
			this.loggingService,
		);

		const isNoneStyle = this.plugin.settings.commentStyle === "none";
		const existingHighlights = isNoneStyle
			? []
			: extractHighlights(existingBody, this.plugin.settings.commentStyle);

		let newHighlightCount = 0;
		let modifiedHighlightCount = 0;

		if (isNoneStyle) {
			newHighlightCount = newAnnotations.length;
			this.loggingService.info(
				this.SCOPE,
				`Comment style is "none" - treating all ${newAnnotations.length} annotations as new for ${existingFile.path}`,
			);
		} else {
			const existingHighlightsMap = new Map(
				existingHighlights.map((h) => [
					this.mergeService.getHighlightKey(h),
					h,
				]),
			);

			for (const newHighlight of newAnnotations) {
				const key = this.mergeService.getHighlightKey(newHighlight);
				const existingMatch = existingHighlightsMap.get(key);

				if (!existingMatch) {
					newHighlightCount++;
				} else {
					if (
						!this.isHighlightTextEqual(
							existingMatch.text || "",
							newHighlight.text || "",
						)
					) {
						modifiedHighlightCount++;
						this.loggingService.info(
							this.SCOPE,
							`Modified highlight found (Page ${newHighlight.pageno}):\n  Old: "${existingMatch.text?.slice(
								0,
								50,
							)}..."\n  New: "${newHighlight.text?.slice(0, 50)}..."`,
						);
					}
					if (!this.isNoteTextEqual(existingMatch.note, newHighlight.note)) {
						if (
							!this.isHighlightTextEqual(
								existingMatch.text || "",
								newHighlight.text || "",
							)
						) {
							this.loggingService.info(
								this.SCOPE,
								`Note also differs for modified highlight (Page ${newHighlight.pageno})`,
							);
						} else {
							modifiedHighlightCount++;
							this.loggingService.info(
								this.SCOPE,
								`Note differs for existing highlight (Page ${newHighlight.pageno}):\n  Old: "${existingMatch.note?.slice(
									0,
									50,
								)}..."\n  New: "${newHighlight.note?.slice(0, 50)}..."`,
							);
						}
					}
				}
			}
		}

		const matchType = this.determineMatchType(
			newHighlightCount,
			modifiedHighlightCount,
		);

		const canMergeSafely =
			(await this.snapshotManager.getSnapshotContent(existingFile)) !== null;

		this.loggingService.info(
			this.SCOPE,
			`Analysis result for ${existingFile.path}: Type=${matchType}, New=${newHighlightCount}, Modified=${modifiedHighlightCount}`,
		);

		return {
			file: existingFile,
			matchType: matchType,
			newHighlights: newHighlightCount,
			modifiedHighlights: modifiedHighlightCount,
			luaMetadata: luaMetadata,
			canMergeSafely: canMergeSafely,
		};
	}

	/**
	 * Creates a new file for the highlights when no merge is needed.
	 * @param luaMetadata - The metadata containing document properties
	 * @param contentProvider - Function to generate the file content
	 * @returns Status object indicating file was created
	 */
	private async createNewFile(
		luaMetadata: LuaMetadata,
		contentProvider: () => Promise<string>,
	): Promise<{ status: "created"; file: TFile }> {
		const content = await contentProvider();
		const fileNameWithExt = this.fileNameGenerator.generate(
			{
				useCustomTemplate: this.plugin.settings.useCustomFileNameTemplate,
				template: this.plugin.settings.fileNameTemplate,
				highlightsFolder: this.plugin.settings.highlightsFolder,
			},
			luaMetadata.docProps,
			luaMetadata.originalFilePath,
		);
		const fileNameStem = getFileNameWithoutExt(fileNameWithExt);

		const targetFile = await this.fs.createVaultFileSafely(
			this.plugin.settings.highlightsFolder,
			fileNameStem, // Use the stem here
			content,
		);

		return { status: "created", file: targetFile };
	}

	/**
	 * Ensures a snapshot exists for the file, creating one if necessary.
	 * Snapshots are required for safe 3-way merges.
	 * @param file - The file to create a snapshot for
	 * @returns True if snapshot exists or was created, false on error
	 */
	private async ensureSnapshot(file: TFile): Promise<boolean> {
		if (await this.snapshotManager.getSnapshotContent(file)) {
			return true;
		}
		try {
			await this.snapshotManager.createSnapshot(file);
			this.loggingService.info(
				this.SCOPE,
				`Created on-the-fly snapshot for ${file.path}`,
			);
			return true;
		} catch (err) {
			this.loggingService.error(
				this.SCOPE,
				`Unable to create snapshot for ${file.path}`,
				err,
			);
			return false;
		}
	}

	/**
	 * Handles duplicate resolution by prompting user or applying auto-merge.
	 * Manages modal locking to prevent concurrent duplicate prompts.
	 * @param analysis - The duplicate analysis results
	 * @param contentProvider - Function to generate new content
	 * @param isAutoMerge - Whether to skip user prompt and auto-merge
	 * @returns The user's choice and resulting file
	 */
	private async handleDuplicate(
		analysis: DuplicateMatch,
		contentProvider: () => Promise<string>,
		isAutoMerge = false,
	): Promise<{ choice: DuplicateChoice; file: TFile | null }> {
		let unlock: () => void;
		const lock = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const prev = this.modalLock;
		this.modalLock = prev.then(() => lock);

		try {
			await prev;
			let choice: DuplicateChoice | null;

			if (isAutoMerge) {
				choice = "automerge";
			} else if (this.applyToAll && this.applyToAllChoice) {
				choice = this.applyToAllChoice;
			} else {
				const modal = this.modalFactory(
					this.app,
					analysis,
					"Duplicate detected – choose an action",
				);
				const res = await modal.openAndGetChoice();
				choice = res.choice ?? "skip";

				if (!this.applyToAll && res.applyToAll) {
					this.applyToAll = true;
					this.applyToAllChoice = choice;
				}
			}

			const finalChoice = choice ?? "skip";
			let newContent: string | null = null;
			if (["replace", "merge", "automerge"].includes(finalChoice)) {
				newContent = await contentProvider();
			}

			const { file } = await this.executeChoice(
				analysis,
				finalChoice,
				newContent,
			);

			return { choice: finalChoice, file };
		} finally {
			unlock!();
		}
	}

	/**
	 * Executes the chosen duplicate resolution action.
	 * @param analysis - The duplicate match analysis
	 * @param choice - The resolution choice (skip/replace/merge/keep-both)
	 * @param newContent - The new content to write/merge (null for skip)
	 * @returns Status and file reference after executing the choice
	 */
	private async executeChoice(
		analysis: DuplicateMatch,
		choice: DuplicateChoice,
		newContent: string | null,
	): Promise<{ status: "created" | "merged" | "skipped"; file: TFile | null }> {
		const { file, luaMetadata } = analysis;

		switch (choice) {
			case "skip":
				return { status: "skipped", file: null };

			case "replace": {
				if (newContent === null) {
					throw new Error("newContent missing for replace action");
				}
				await this.snapshotManager.createBackup(file);
				await this.app.vault.modify(file, newContent);
				return { status: "merged", file };
			}

			case "merge":
			case "automerge": {
				let base = await this.snapshotManager.getSnapshotContent(file);
				if (!base && (await this.ensureSnapshot(file))) {
					base = await this.snapshotManager.getSnapshotContent(file);
				}

				if (!base) {
					if (choice === "automerge") {
						this.loggingService.warn(
							this.SCOPE,
							`Auto-merge skipped for ${file.path}: No snapshot available for a safe 3-way merge.`,
						);
						return { status: "skipped", file: null };
					}

					const confirmed = await new ConfirmModal(
						this.app,
						"Snapshot Not Available",
						"A 3-way merge is not possible without a snapshot of the last import. Local edits may be lost.\n\nDo you want to proceed with a 2-way merge?",
					).openAndConfirm();

					if (!confirmed) return { status: "skipped", file: null };
					this.loggingService.warn(
						this.SCOPE,
						`User confirmed 2-way merge for ${file.path} despite missing snapshot.`,
					);
					return this.mergeService.execute2WayMerge(file, luaMetadata);
				}

				if (newContent === null) {
					throw new Error("newContent missing for 3-way merge");
				}
				return this.mergeService.execute3WayMerge(
					file,
					base,
					newContent,
					luaMetadata,
				);
			}

			case "keep-both":
				return { status: "created", file: null };

			default:
				return { status: "skipped", file: null };
		}
	}

	/**
	 * Normalizes text for comparison by removing extra whitespace.
	 * @param text - Text to normalize
	 * @returns Normalized lowercase string
	 */
	private normalizeForComparison(text?: string): string {
		return text?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
	}

	/**
	 * Compares two highlight texts for equality after normalization.
	 * @param text1 - First highlight text
	 * @param text2 - Second highlight text
	 * @returns True if texts are effectively equal
	 */
	private isHighlightTextEqual(text1: string, text2: string): boolean {
		return (
			this.normalizeForComparison(text1) === this.normalizeForComparison(text2)
		);
	}

	/**
	 * Compares two note texts for equality after normalization.
	 * @param note1 - First note text
	 * @param note2 - Second note text
	 * @returns True if notes are effectively equal
	 */
	private isNoteTextEqual(note1?: string, note2?: string): boolean {
		return (
			this.normalizeForComparison(note1) === this.normalizeForComparison(note2)
		);
	}

	/**
	 * Determines the type of duplicate match based on differences.
	 * @param newCount - Number of new highlights
	 * @param modifiedCount - Number of modified highlights
	 * @returns Match type: "exact", "updated", or "divergent"
	 */
	private determineMatchType(
		newCount: number,
		modifiedCount: number,
	): DuplicateMatch["matchType"] {
		if (newCount === 0 && modifiedCount === 0) return "exact";
		if (modifiedCount > 0) return "divergent";
		if (newCount > 0) return "updated";
		return "exact";
	}
}
