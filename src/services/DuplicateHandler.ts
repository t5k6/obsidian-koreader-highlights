import { type App, TFile, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type {
	Annotation,
	DocProps,
	DuplicateChoice,
	DuplicateMatch,
	IDuplicateHandlingModal,
	LuaMetadata,
} from "../types";
import { compareAnnotations } from "../utils/formatUtils";
import { extractHighlights } from "../utils/highlightExtractor";
import { devLog, devWarn } from "../utils/logging";
import type { ContentGenerator } from "./ContentGenerator";
import type { DatabaseService } from "./DatabaseService";
import type { FrontmatterGenerator } from "./FrontmatterGenerator";

export class DuplicateHandler {
	currentMatch: NonNullable<DuplicateMatch> | null = null;
	public applyToAll = false;
	public applyToAllChoice: DuplicateChoice | null = null;
	private potentialDuplicatesCache: Map<string, TFile[]> = new Map();

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
	) {}

	/** Resets the "Apply to All" state. Call before starting a new batch import. */
	public resetApplyToAll(): void {
		this.applyToAll = false;
		this.applyToAllChoice = null;
		this.currentMatch = null;
		devLog("DuplicateHandler 'Apply to All' state reset.");
	}

	/** Clears the internal cache of potential duplicates. */
	public clearCache(): void {
		this.potentialDuplicatesCache.clear();
		devLog("DuplicateHandler potential duplicates cache cleared.");
	}

	public async handleDuplicate(
		analysis: DuplicateMatch,
		newAnn: Annotation[],
		luaMeta: LuaMetadata,
		contentProvider: string | (() => Promise<string>),
	): Promise<{ choice: DuplicateChoice; file: TFile | null }> {
		let choice: DuplicateChoice | null;

		if (this.applyToAll && this.applyToAllChoice) {
			devLog(`Using cached duplicate action '${this.applyToAllChoice}'.`);
			choice = this.applyToAllChoice;
		} else {
			const modal = this.modalFactory(
				this.app,
				analysis,
				"Duplicate detected – choose an action",
			);
			const res = await modal.openAndGetChoice();
			choice = res.choice;

			this.applyToAll = !!res.applyToAll;
			if (this.applyToAll && choice) {
				this.applyToAllChoice = choice;
			}
		}

		const finalChoice = choice ?? "skip";

		// Resolve the content only if needed by the chosen action.
		let newContent: string | null = null;
		if (finalChoice === "replace") {
			newContent =
				typeof contentProvider === "function"
					? await contentProvider()
					: contentProvider;
		}

		const actionResult = await this.executeChoice(
			analysis.file,
			finalChoice,
			newAnn,
			luaMeta,
			newContent, // Pass the resolved content, which may be null
		);

		return { choice: finalChoice, file: actionResult.file };
	}

	public async findPotentialDuplicates(docProps: DocProps): Promise<TFile[]> {
		const bookKey = this.databaseService.bookKeyFromDocProps(docProps);

		devLog(`Querying index for existing files with book key: ${bookKey}`);
		const paths = await this.databaseService.findExistingBookFiles(bookKey);

		const files = paths
			.map((p) => this.app.vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f instanceof TFile);

		devLog(`Found ${files.length} potential duplicate(s) for key: ${bookKey}`);
		return files;
	}

	async analyzeDuplicate(
		existingFile: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		devLog(`Analyzing duplicate content: ${existingFile.path}`);
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
					devLog(
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
						devLog(
							`Note also differs for modified highlight (Page ${newHighlight.pageno})`,
						);
					} else {
						// Text is same, but note differs - count as modified
						modifiedHighlightCount++;
						devLog(
							`Note differs for existing highlight (Page ${newHighlight.pageno}):\n  Old: "${existingMatch.note?.slice(
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
		devLog(
			`Analysis result for ${existingFile.path}: Type=${matchType}, New=${newHighlightCount}, Modified=${modifiedHighlightCount}`,
		);

		return {
			file: existingFile,
			matchType: matchType,
			newHighlights: newHighlightCount,
			modifiedHighlights: modifiedHighlightCount,
			luaMetadata: luaMetadata,
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
				// 1. Generate the new body from incoming highlights.
				const newBody = await this.contentGenerator.generateHighlightsContent(
					newAnnotations, // Use only the new annotations
					luaMetadata,
				);

				// 2. Read the existing file to get its frontmatter.
				const existingContent = await this.app.vault.read(file);
				let existingFrontmatter = "";

				if (existingContent.startsWith("---")) {
					const endOfFrontmatter = existingContent.indexOf("\n---", 3);
					if (endOfFrontmatter !== -1) {
						existingFrontmatter = existingContent.substring(
							0,
							endOfFrontmatter + 4,
						);
					}
				}

				// 3. Combine the old frontmatter with the new body.
				const finalContent = `${existingFrontmatter}\n\n${newBody.trim()}`;

				// 4. Overwrite the file.
				await this.app.vault.modify(file, finalContent);
				return { status: "merged", file };
			}

			case "merge": {
				const existingContent = await this.app.vault.read(file);
				const existingAnnotations = extractHighlights(existingContent);

				const merged = await this.mergeContents(
					file,
					existingAnnotations,
					newAnnotations,
					luaMetadata,
				);
				await this.app.vault.modify(file, merged);
				return { status: "merged", file };
			}

			case "keep-both":
				return { status: "created", file: null };

			default:
				return { status: "skipped", file: null };
		}
	}

	private mergeAnnotationArrays(
		existing: Annotation[],
		incoming: Annotation[],
	): Annotation[] {
		const key = (a: Annotation) =>
			`${a.pageno}|${a.pos0}|${a.pos1}|${(a.text || "").trim()}`;

		const seen = new Set(existing.map(key));
		const out = [...existing];

		for (const ann of incoming) {
			if (!seen.has(key(ann))) {
				out.push(ann);
				seen.add(key(ann));
			}
		}
		return out.sort(compareAnnotations);
	}

	/** Merges two frontmatter objects. Prioritizes existing values generally, updates specific fields. */
	private async mergeContents(
		file: TFile,
		existingAnnotations: Annotation[],
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<string> {
		const combined = this.mergeAnnotationArrays(
			existingAnnotations,
			newAnnotations,
		);

		const newBody = await this.contentGenerator.generateHighlightsContent(
			combined,
			luaMetadata,
		);

		const raw = await this.app.vault.read(file);

		if (!newBody.trim()) {
			devWarn(
				`mergeContents(): no highlights left for ${file.path}. Keeping the old body.`,
			);
			return raw; // write the original content back
		}

		let front = "";
		if (raw.startsWith("---")) {
			const end = raw.indexOf("\n---", 3);
			if (end !== -1) front = raw.slice(0, end + 4).trim();
		}
		return [front, newBody].filter(Boolean).join("\n\n");
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
		// Use page number and starting position (if available) for uniqueness
		const pos0 = annotation.pos0 ?? "";
		const pos1 = annotation.pos1 ?? "";
		const txt = (annotation.text ?? "").trim().slice(0, 32); // cheap hash
		return `p${annotation.pageno}-${pos0}-${pos1}-${txt}`;
	}
}
