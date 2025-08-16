import type { MergeRegion } from "node-diff3";
import { diff3Merge } from "node-diff3";
import type { App, TFile, Vault } from "obsidian";
import {
	compareAnnotations,
	getHighlightKey,
} from "src/lib/formatting/formatUtils";
import { extractHighlightsWithStyle } from "src/lib/parsing/highlightExtractor";
import type KoreaderImporterPlugin from "src/main";
import type { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { Annotation, LuaMetadata } from "src/types";
import type { LoggingService } from "../LoggingService";
import type { ContentGenerator } from "./ContentGenerator";
import type { SnapshotManager } from "./SnapshotManager";

export class MergeService {
	private readonly log;

	constructor(
		private app: App,
		private vault: Vault,
		private plugin: KoreaderImporterPlugin,
		private snapshotManager: SnapshotManager,
		private fmService: FrontmatterService,
		private frontmatterGenerator: FrontmatterGenerator,
		private contentGenerator: ContentGenerator,
		private loggingService: LoggingService,
	) {
		this.log = this.loggingService.scoped("MergeService");
	}

	/**
	 * Performs a 2-way merge when no snapshot is available.
	 * Merges annotations and frontmatter without conflict detection.
	 * @param file - The existing file to merge into
	 * @param luaMetadata - New metadata to merge
	 * @returns Status indicating merge completion
	 */
	public async execute2WayMerge(
		file: TFile,
		luaMetadata: LuaMetadata,
	): Promise<{ status: "merged"; file: TFile }> {
		await this.snapshotManager.createBackup(file);
		const { frontmatter: existingFm, body: existingBody } =
			await this.fmService.parseFile(file);
		const { annotations: existingAnnotations } = extractHighlightsWithStyle(
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

		const finalContent = this.fmService.reconstructFileContent(
			mergedFm,
			newBody,
		);
		await this.app.vault.modify(file, finalContent);

		return { status: "merged", file };
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
	public async execute3WayMerge(
		file: TFile,
		baseContent: string,
		newFileContent: string,
		luaMetadata: LuaMetadata,
	): Promise<{ status: "merged"; file: TFile }> {
		await this.snapshotManager.createBackup(file);

		const base = this.fmService.parseContent(baseContent);
		const ours = await this.fmService.parseFile(file);
		const theirs = this.fmService.parseContent(newFileContent);

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

		const finalContent = this.fmService.reconstructFileContent(
			mergedFm,
			mergedBody,
		);

		if (hasConflict) {
			this.log.warn(
				`Merge conflict detected in ${file.path}. Adding conflict callouts.`,
			);
		} else {
			this.log.info(
				`Successfully merged content for ${file.path} without conflicts.`,
			);
		}

		await this.vault.modify(file, finalContent);
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
		const map = new Map(existing.map((ann) => [getHighlightKey(ann), ann]));

		for (const ann of incoming) {
			const k = getHighlightKey(ann);
			if (!map.has(k)) {
				map.set(k, ann);
			}
		}

		return Array.from(map.values()).sort(compareAnnotations);
	}
}
