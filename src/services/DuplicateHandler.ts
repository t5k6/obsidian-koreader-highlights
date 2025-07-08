import { diff3Merge, type MergeRegion } from "node-diff3";
import { type App, TFile, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ConfirmModal } from "src/ui/ConfirmModal";
import { compareAnnotations, computeAnnotationId } from "src/utils/formatUtils";
import { extractHighlights } from "src/utils/highlightExtractor";
import { logger } from "src/utils/logging";
import { getFrontmatterAndBody } from "src/utils/obsidianUtils";
import type {
	Annotation,
	DocProps,
	DuplicateChoice,
	DuplicateMatch,
	IDuplicateHandlingModal,
	LuaMetadata,
} from "../types";
import type { ContentGenerator } from "./ContentGenerator";
import type { DatabaseService } from "./DatabaseService";
import type { FrontmatterGenerator } from "./FrontmatterGenerator";
import type { SnapshotManager } from "./SnapshotManager";

export class DuplicateHandler {
	currentMatch: NonNullable<DuplicateMatch> | null = null;
	public applyToAll = false;
	public applyToAllChoice: DuplicateChoice | null = null;
	private potentialDuplicatesCache: Map<string, TFile[]> = new Map();
	private modalLock: Promise<void> = Promise.resolve();

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
	) {}

	/** Resets the "Apply to All" state. Call before starting a new batch import. */
	public resetApplyToAll(): void {
		this.applyToAll = false;
		this.applyToAllChoice = null;
		this.currentMatch = null;
		logger.info("DuplicateHandler: 'Apply to All' state reset.");
	}

	/** Clears the internal cache of potential duplicates. */
	public clearCache(): void {
		this.potentialDuplicatesCache.clear();
		logger.info("DuplicateHandler: potential duplicates cache cleared.");
	}

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
	 * Handles a detected duplicate file. Presents a modal to the user or uses
	 * existing 'apply to all' preferences to decide how to proceed.
	 */
	public async handleDuplicate(
		analysis: DuplicateMatch,
		newAnn: Annotation[],
		luaMeta: LuaMetadata,
		contentProvider: string | (() => Promise<string>),
		isAutoMerge = false,
	): Promise<{ choice: DuplicateChoice; file: TFile | null }> {
		/* -----------------------------------------------------------
		   1️⃣  Acquire a lock so that only ONE modal runs at a time.
		----------------------------------------------------------- */
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
				// Programmatic merge, no user interaction.
				choice = "automerge";
				logger.info("DuplicateHandler: Auto-merging based on settings.");
			} else if (this.applyToAll && this.applyToAllChoice) {
				// User already picked “apply to all” earlier in this run.
				logger.info(
					`DuplicateHandler: Using cached duplicate action '${this.applyToAllChoice}'.`,
				);
				choice = this.applyToAllChoice;
			} else {
				// Need to ask the user.
				const modal = this.modalFactory(
					this.app,
					analysis,
					"Duplicate detected – choose an action",
				);

				const res = await modal.openAndGetChoice(); // {choice, applyToAll}
				choice = res.choice ?? "skip";

				/* --------------------------------------------------------------
				Only *set* apply-to-all flags the FIRST time the user ticks the
				checkbox.
				-------------------------------------------------------------- */
				if (!this.applyToAll && res.applyToAll) {
					this.applyToAll = true;
					this.applyToAllChoice = choice;
				}
			}

			const finalChoice = choice ?? "skip";
			/* ------------------------------------------------------- */
			/*  Resolve content lazily + execute the choice            */
			/* ------------------------------------------------------- */

			let newContent: string | null = null;
			if (["replace", "merge", "automerge"].includes(finalChoice)) {
				newContent =
					typeof contentProvider === "function"
						? await contentProvider()
						: contentProvider;
			}

			const { file } = await this.executeChoice(
				analysis.file,
				finalChoice,
				newAnn,
				luaMeta,
				newContent,
			);

			return { choice: finalChoice, file };
		} finally {
			unlock!(); // release lock so next queued call can run
		}
	}

	/**
	 * Finds potential duplicate files in the vault based on book metadata.
	 * Uses KOReaderImporter's database to find existing files with the same book key.
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

	async analyzeDuplicate(
		existingFile: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		logger.info(
			`DuplicateHandler: Analyzing duplicate content: ${existingFile.path}`,
		);
		const existingContent = await this.vault.read(existingFile);
		const fileCache = this.app.metadataCache.getFileCache(existingFile);

		// Get body content after frontmatter using Obsidian's metadata
		const existingBody = fileCache?.frontmatterPosition
			? existingContent.slice(fileCache.frontmatterPosition.end.offset)
			: existingContent;

		const existingHighlights = extractHighlights(existingBody);

		let newHighlightCount = 0;
		let modifiedHighlightCount = 0;

		const existingHighlightsMap = new Map(
			existingHighlights.map((h) => [this.getHighlightKey(h), h]),
		);

		for (const newHighlight of newAnnotations) {
			const key = this.getHighlightKey(newHighlight);
			const existingMatch = existingHighlightsMap.get(key);

			if (!existingMatch) {
				newHighlightCount++;
			} else {
				// Check if text content differs significantly (case-insensitive, whitespace normalized)
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
						// Text is same, but note differs - count as modified
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

	private async executeChoice(
		file: TFile,
		choice: DuplicateChoice,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
		newContent: string | null,
	): Promise<{ status: "created" | "merged" | "skipped"; file: TFile | null }> {
		switch (choice) {
			case "skip":
				return { status: "skipped", file: null };

			case "replace": {
				if (newContent === null) {
					throw new Error("newContent missing for replace action");
				}
				await this.app.vault.modify(file, newContent);
				return { status: "merged", file };
			}

			case "merge":
			case "automerge": {
				// Step 1: Make sure a base snapshot is available.
				let base = await this.snapshotManager.getSnapshotContent(file);
				if (!base) {
					// Try to create one automatically if it's missing.
					if (await this.ensureSnapshot(file)) {
						base = await this.snapshotManager.getSnapshotContent(file);
					}
				}

				// Step 2: If still no base, a 3-way merge is impossible.
				// For manual merges, ask the user. Auto-merges should just skip.
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

					if (!confirmed) {
						return { status: "skipped", file: null };
					}
					logger.warn(
						`DuplicateHandler: User confirmed 2-way merge for ${file.path} despite missing snapshot.`,
					);
					return this.execute2WayMerge(file, newAnnotations, luaMetadata);
				}

				// Step 3: Proceed with the safe 3-way merge.
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

	private async execute2WayMerge(
		file: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<{ status: "merged"; file: TFile }> {
		const { frontmatter: existingFm, body: existingBody } =
			await getFrontmatterAndBody(this.app, file);
		const existingAnnotations = extractHighlights(existingBody);

		const mergedAnnotations = this.mergeAnnotationArrays(
			existingAnnotations,
			newAnnotations,
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

	private async execute3WayMerge(
		file: TFile,
		baseContent: string,
		newFileContent: string,
		luaMetadata: LuaMetadata,
	): Promise<{ status: "merged"; file: TFile }> {
		// 1. Split all three versions into frontmatter and body.
		const { body: baseBody } = await getFrontmatterAndBody(this.app, {
			content: baseContent,
		});
		const { frontmatter: ourFm, body: ourBody } = await getFrontmatterAndBody(
			this.app,
			file,
		);
		const { body: theirBody } = await getFrontmatterAndBody(this.app, {
			content: newFileContent,
		});

		// 2. Perform 3-way merge on the body content, splitting it into lines.
		const mergeRegions: MergeRegion<string>[] = diff3Merge(
			ourBody.split("\n"),
			baseBody.split("\n"),
			theirBody.split("\n"),
		);

		// 3. Process the merge regions to build the final body and detect conflicts.
		const mergedLines: string[] = [];
		let hasConflict = false;

		for (const region of mergeRegions) {
			if (region.ok) {
				// This is a stable, non-conflicting chunk.
				mergedLines.push(...region.ok);
			}
			if (region.conflict) {
				// This is a conflict. Mark it and add conflict markers.
				hasConflict = true;
				mergedLines.push("<<<<<<< YOUR VERSION");
				mergedLines.push(...region.conflict.a);
				mergedLines.push("=======");
				mergedLines.push(...region.conflict.b);
				mergedLines.push(">>>>>>> INCOMING VERSION");
			}
		}
		const mergedBody = mergedLines.join("\n");

		// 4. Re-assemble the final file content with SMART frontmatter merging.
		let finalContent: string;
		const mergedFm = this.frontmatterGenerator.mergeFrontmatterData(
			ourFm ?? {},
			luaMetadata,
			this.plugin.settings.frontmatter,
		);
		const finalFm = this.frontmatterGenerator.formatDataToYaml(mergedFm, {
			useFriendlyKeys: true,
			sortKeys: true,
		});

		if (hasConflict) {
			logger.warn(
				`DuplicateHandler: Merge conflict detected in ${file.path}. Adding conflict markers.`,
			);
			const conflictCallout = `> [!caution] Merge Conflict Detected\n> This note contains conflicting changes between the version in your vault and the new version from KOReader. Please search for \`<<<<<<<\` to resolve them manually.\n\n`;
			finalContent = `${finalFm}\n\n${conflictCallout}${mergedBody}`;
		} else {
			logger.info(
				`DuplicateHandler: Successfully merged content for ${file.path} without conflicts.`,
			);
			finalContent = `${finalFm}\n\n${mergedBody}`;
		}

		// 5. Write the result back to the vault.
		await this.vault.modify(file, finalContent);
		return { status: "merged", file };
	}

	private mergeAnnotationArrays(
		existing: Annotation[],
		incoming: Annotation[],
	): Annotation[] {
		const key = (a: Annotation) =>
			`${a.pageno}|${a.pos0}|${a.pos1}|${(a.text || "").trim()}`;

		// Use a map to store existing annotations, keyed for quick lookup.
		// This preserves the full `existing` annotation object on collision.
		const map = new Map(existing.map((ann) => [key(ann), ann]));

		for (const ann of incoming) {
			const k = key(ann);
			// Only add the incoming annotation if its key is not already in the map.
			if (!map.has(k)) {
				map.set(k, ann);
			}
		}

		return Array.from(map.values()).sort(compareAnnotations);
	}

	/** Normalizes text for comparison (trim, collapse whitespace, lowercase). */
	private normalizeForComparison(text?: string): string {
		return text?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
	}

	/** Checks if two highlight text blocks are functionally equal (ignore whitespace/case). */
	private isHighlightTextEqual(text1: string, text2: string): boolean {
		return (
			this.normalizeForComparison(text1) === this.normalizeForComparison(text2)
		);
	}

	/** Checks if two notes are functionally equal (ignore whitespace/case). */
	private isNoteTextEqual(note1?: string, note2?: string): boolean {
		return (
			this.normalizeForComparison(note1) === this.normalizeForComparison(note2)
		);
	}

	private determineMatchType(
		newCount: number,
		modifiedCount: number,
	): DuplicateMatch["matchType"] {
		if (newCount === 0 && modifiedCount === 0) return "exact";
		if (modifiedCount > 0) return "divergent";
		if (newCount > 0) return "updated"; // Only new highlights added
		return "exact";
	}

	private getHighlightKey(annotation: Annotation): string {
		return annotation.id ?? computeAnnotationId(annotation);
	}
}
