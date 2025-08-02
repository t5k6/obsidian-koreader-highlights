import type { MergeRegion } from "node-diff3";
import { diff3Merge } from "node-diff3";
import { type App, TFile, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import type { ContentGenerator } from "src/services/vault/ContentGenerator";
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
import {
	compareAnnotations,
	computeAnnotationId,
	generateObsidianFileName,
} from "src/utils/formatUtils";
import { extractHighlights } from "src/utils/highlightExtractor";
import { logger } from "src/utils/logging";
import { getFrontmatterAndBody } from "src/utils/obsidianUtils";
import type { DatabaseService } from "../DatabaseService";
import type { FileSystemService } from "../FileSystemService";
import type { SnapshotManager } from "./SnapshotManager";

type ResolveStatus = "created" | "merged" | "automerged" | "skipped";

export class DuplicateHandler {
	currentMatch: NonNullable<DuplicateMatch> | null = null;
	public applyToAll = false;
	public applyToAllChoice: DuplicateChoice | null = null;
	private modalLock: Promise<void> = Promise.resolve();
	private potentialDuplicatesCache: Map<string, TFile[]>;

	constructor(
		private vault: Vault,
		private app: App,
		private modalFactory: (
			app: App,
			match: DuplicateMatch,
			message: string,
		) => IDuplicateHandlingModal,
		private frontmatterGenerator: FrontmatterGenerator,
		private plugin: KoreaderImporterPlugin,
		private contentGenerator: ContentGenerator,
		private databaseService: DatabaseService,
		private snapshotManager: SnapshotManager,
		private cacheManager: CacheManager,
		private fs: FileSystemService,
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
		logger.info("DuplicateHandler: 'Apply to All' state reset.");
	}

	/**
	 * Clears the internal cache of potential duplicates.
	 * Frees memory and ensures fresh duplicate detection on next run.
	 */
	public clearCache(): void {
		this.potentialDuplicatesCache.clear();
		logger.info("DuplicateHandler: potential duplicates cache cleared.");
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
			logger.info(
				`DuplicateHandler: Auto-merging additions into ${bestMatch.file.path} via safe 3-way merge.`,
			);
			const { file } = await this.handleDuplicate(
				bestMatch,
				contentProvider,
				true,
			);
			return { status: file ? "automerged" : "skipped", file };
		}

		if (autoMergeEnabled && isUpdateOnly && !snapshotExists) {
			logger.info(
				`DuplicateHandler: Skipping auto-merge for ${bestMatch.file.path} because no snapshot exists. Prompting user.`,
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
				logger.warn(`DuplicateHandler: Unhandled choice: ${choice}`);
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
		const bookKey = this.databaseService.bookKeyFromDocProps(docProps);
		if (this.potentialDuplicatesCache.has(bookKey)) {
			logger.info(
				`DuplicateHandler: Cache hit for potential duplicates of key: ${bookKey}`,
			);
			return this.potentialDuplicatesCache.get(bookKey)!;
		}

		logger.info(
			`DuplicateHandler: Querying index for existing files with book key: ${bookKey}`,
		);
		const paths = await this.databaseService.findExistingBookFiles(bookKey);

		const files = paths
			.map((p) => this.app.vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f instanceof TFile);

		logger.info(
			`DuplicateHandler: Found ${files.length} potential duplicate(s) for key: ${bookKey}`,
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
		logger.info(
			`DuplicateHandler: Analyzing duplicate content: ${existingFile.path}`,
		);
		const { body: existingBody } = await getFrontmatterAndBody(
			this.app,
			existingFile,
		);

		// When comment style is "none", we can't extract highlights for comparison
		// So we treat all new annotations as potentially new
		const isNoneStyle = this.plugin.settings.commentStyle === "none";
		const existingHighlights = isNoneStyle
			? []
			: extractHighlights(existingBody, this.plugin.settings.commentStyle);

		let newHighlightCount = 0;
		let modifiedHighlightCount = 0;

		if (isNoneStyle) {
			newHighlightCount = newAnnotations.length;
			logger.info(
				`DuplicateHandler: Comment style is "none" - treating all ${newAnnotations.length} annotations as new for ${existingFile.path}`,
			);
		} else {
			const existingHighlightsMap = new Map(
				existingHighlights.map((h) => [this.getHighlightKey(h), h]),
			);

			for (const newHighlight of newAnnotations) {
				const key = this.getHighlightKey(newHighlight);
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
						logger.info(
							`DuplicateHandler: Modified highlight found (Page ${newHighlight.pageno}):\n  Old: "${existingMatch.text?.slice(
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
							logger.info(
								`DuplicateHandler: Note also differs for modified highlight (Page ${newHighlight.pageno})`,
							);
						} else {
							modifiedHighlightCount++;
							logger.info(
								`DuplicateHandler: Note differs for existing highlight (Page ${newHighlight.pageno}):\n  Old: "${existingMatch.note?.slice(
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

		logger.info(
			`DuplicateHandler: Analysis result for ${existingFile.path}: Type=${matchType}, New=${newHighlightCount}, Modified=${modifiedHighlightCount}`,
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
		const fileName = generateObsidianFileName(
			luaMetadata.docProps,
			this.plugin.settings.highlightsFolder,
			luaMetadata.originalFilePath,
		);

		const targetFile = await this.fs.createVaultFileSafely(
			this.plugin.settings.highlightsFolder,
			fileName,
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
			logger.info(
				`DuplicateHandler: Created on-the-fly snapshot for ${file.path}`,
			);
			return true;
		} catch (err) {
			logger.error(
				`DuplicateHandler: Unable to create snapshot for ${file.path}`,
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
						logger.warn(
							`DuplicateHandler: Auto-merge skipped for ${file.path}: No snapshot available for a safe 3-way merge.`,
						);
						return { status: "skipped", file: null };
					}

					const confirmed = await new ConfirmModal(
						this.app,
						"Snapshot Not Available",
						"A 3-way merge is not possible without a snapshot of the last import. Local edits may be lost.\n\nDo you want to proceed with a 2-way merge?",
					).openAndConfirm();

					if (!confirmed) return { status: "skipped", file: null };
					logger.warn(
						`DuplicateHandler: User confirmed 2-way merge for ${file.path} despite missing snapshot.`,
					);
					return this.execute2WayMerge(file, luaMetadata);
				}

				if (newContent === null) {
					throw new Error("newContent missing for 3-way merge");
				}
				return this.execute3WayMerge(file, base, newContent, luaMetadata);
			}

			case "keep-both":
				return { status: "created", file: null };

			default:
				return { status: "skipped", file: null };
		}
	}

	/**
	 * Performs a 2-way merge when no snapshot is available.
	 * Merges annotations and frontmatter without conflict detection.
	 * @param file - The existing file to merge into
	 * @param luaMetadata - New metadata to merge
	 * @returns Status indicating merge completion
	 */
	private async execute2WayMerge(
		file: TFile,
		luaMetadata: LuaMetadata,
	): Promise<{ status: "merged"; file: TFile }> {
		await this.snapshotManager.createBackup(file);
		const { frontmatter: existingFm, body: existingBody } =
			await getFrontmatterAndBody(this.app, file);
		const existingAnnotations = extractHighlights(
			existingBody,
			this.plugin.settings.commentStyle,
		);

		const mergedAnnotations = this.mergeAnnotationArrays(
			existingAnnotations,
			luaMetadata.annotations,
		);

		const newBody =
			await this.contentGenerator.generateHighlightsContent(mergedAnnotations);

		const mergedFm = this.frontmatterGenerator.mergeFrontmatterData(
			existingFm ?? {},
			luaMetadata,
			this.plugin.settings.frontmatter,
		);
		const newFrontmatter = this.frontmatterGenerator.formatDataToYaml(
			mergedFm,
			{ useFriendlyKeys: true, sortKeys: true },
		);

		const finalContent = [newFrontmatter, newBody].filter(Boolean).join("\n\n");
		await this.app.vault.modify(file, finalContent);

		return { status: "merged", file };
	}

	/**
	 * Performs a 3-way diff to detect conflicts between versions.
	 * @param ours - Current vault version
	 * @param base - Last imported version (snapshot)
	 * @param theirs - New KOReader version
	 * @returns Array of merge regions with conflicts marked
	 */
	private performSynchronousDiff3(
		ours: string,
		base: string,
		theirs: string,
	): MergeRegion<string>[] {
		return diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"));
	}

	/**
	 * Performs a safe 3-way merge using snapshots to preserve user edits.
	 * Adds conflict markers when automatic resolution isn't possible.
	 * @param file - The existing file to merge into
	 * @param baseContent - The snapshot content (common ancestor)
	 * @param newFileContent - The new content from KOReader
	 * @param luaMetadata - Metadata for frontmatter merging
	 * @returns Status indicating merge completion
	 */
	private async execute3WayMerge(
		file: TFile,
		baseContent: string,
		newFileContent: string,
		luaMetadata: LuaMetadata,
	): Promise<{ status: "merged"; file: TFile }> {
		await this.snapshotManager.createBackup(file);

		const parse = async (source: TFile | string) => {
			const content = typeof source === "string" ? { content: source } : source;
			return getFrontmatterAndBody(this.app, content);
		};

		const base = await parse(baseContent);
		const ours = await parse(file);
		const theirs = await parse(newFileContent);

		const mergeRegions = this.performSynchronousDiff3(
			ours.body,
			base.body,
			theirs.body,
		);

		const mergedLines: string[] = [];
		let hasConflict = false;
		let initialConflictCalloutAdded = false;

		for (const region of mergeRegions) {
			if (region.ok) {
				mergedLines.push(...region.ok);
			} else if (region.conflict) {
				hasConflict = true;

				if (!initialConflictCalloutAdded) {
					mergedLines.push(
						`> [!caution] Merge Conflict Detected`,
						`> This note contains conflicting changes between the version in your vault and the new version from KOReader. Please resolve the conflicts below and then remove the conflict blocks.`,
					);
					initialConflictCalloutAdded = true;
				}

				mergedLines.push(
					`\n> [!conflict]- Conflict Start: Your Edits (Vault)`,
					...region.conflict.a.map((line) => `> ${line}`),
					`> [!tip]- Incoming Changes (KOReader)`,
					...region.conflict.b.map((line) => `> ${line}`),
					`> [!conflict]- Conflict End`,
					`\n`,
				);
			}
		}
		const mergedBody = mergedLines.join("\n");

		const mergedFm = this.frontmatterGenerator.mergeFrontmatterData(
			ours.frontmatter ?? {},
			luaMetadata,
			this.plugin.settings.frontmatter,
		);

		mergedFm["last-merged"] = new Date().toISOString().slice(0, 10);
		if (hasConflict) {
			mergedFm.conflicts = "unresolved";
		}

		const finalFm = this.frontmatterGenerator.formatDataToYaml(mergedFm, {
			useFriendlyKeys: true,
			sortKeys: true,
		});

		const finalContent = `${finalFm}\n\n${mergedBody}`;

		if (hasConflict) {
			logger.warn(
				`DuplicateHandler: Merge conflict detected in ${file.path}. Adding conflict callouts.`,
			);
		} else {
			logger.info(
				`DuplicateHandler: Successfully merged content for ${file.path} without conflicts.`,
			);
		}

		await this.vault.modify(file, finalContent);
		return { status: "merged", file };
	}

	/**
	 * Merges two arrays of annotations, avoiding duplicates.
	 * Uses highlight keys for deduplication.
	 * @param existing - Existing annotations in the vault
	 * @param incoming - New annotations from KOReader
	 * @returns Merged array sorted by position
	 */
	private mergeAnnotationArrays(
		existing: Annotation[],
		incoming: Annotation[],
	): Annotation[] {
		const map = new Map(
			existing.map((ann) => [this.getHighlightKey(ann), ann]),
		);

		for (const ann of incoming) {
			const k = this.getHighlightKey(ann);
			if (!map.has(k)) {
				map.set(k, ann);
			}
		}

		return Array.from(map.values()).sort(compareAnnotations);
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

	/**
	 * Gets a unique key for an annotation used for deduplication.
	 * @param annotation - The annotation to get a key for
	 * @returns Unique identifier string
	 */
	private getHighlightKey(annotation: Annotation): string {
		return annotation.id ?? computeAnnotationId(annotation);
	}
}
