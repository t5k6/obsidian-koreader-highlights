import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { Annotation, LuaMetadata } from "../types";
import {
	compareAnnotations,
	distanceBetweenHighlights,
	isWithinGap,
} from "../utils/formatUtils";
import type { TemplateManager } from "./TemplateManager";

interface SuccessiveGroup {
	annotations: Annotation[];
	separators: (" " | " [...] ")[];
}

export class ContentGenerator {
	constructor(
		private templateManager: TemplateManager,
		private plugin: KoreaderImporterPlugin,
	) {}

	async generateHighlightsContent(
		annotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<string> {
		if (!annotations || annotations.length === 0) {
			return "";
		}

		const { fn: compiledTemplate, features } =
			await this.templateManager.getCompiledTemplate();

		// 1. Group all annotations by chapter name.
		const groupedByChapter = annotations.reduce(
			(acc, highlight) => {
				const chapter = highlight.chapter?.trim() || "Chapter Unknown";
				if (!acc[chapter]) {
					acc[chapter] = [];
				}
				acc[chapter].push(highlight);
				return acc;
			},
			{} as Record<string, Annotation[]>,
		);

		// 2. Create a sortable array of chapters, finding the starting page for each.
		const chaptersToSort = Object.entries(groupedByChapter).map(
			([chapterName, chapterAnnotations]) => {
				const sortedHighlights = [...chapterAnnotations].sort(
					compareAnnotations,
				);

				sortedHighlights.forEach((ann) => {
					ann.chapter = chapterName;
				});
				const startPage = sortedHighlights[0]?.pageno ?? 0;

				return {
					name: chapterName,
					startPage: startPage,
					annotations: sortedHighlights,
				};
			},
		);

		// 3. Sort the chapters themselves based on their starting page number.
		chaptersToSort.sort((a, b) => a.startPage - b.startPage);

		// 4. Render the chapters in the now-correct order.
		let finalContent = "";
		for (const chapterData of chaptersToSort) {
			const chapterHighlights = chapterData.annotations;
			if (!chapterHighlights || chapterHighlights.length === 0) continue;

			let isFirstHighlightInChapter = true;
			const groupedSuccessiveHighlights =
				this.groupSuccessiveHighlights(chapterHighlights);

			let chapterContent = "";
			for (const highlightGroup of groupedSuccessiveHighlights) {
				chapterContent += this.templateManager.renderGroup(
					compiledTemplate,
					highlightGroup.annotations,
					{
						separators: highlightGroup.separators,
						isFirstInChapter: isFirstHighlightInChapter,
					},
				);
				isFirstHighlightInChapter = false;

				if (features.autoInsertDivider) {
					chapterContent += "\n\n---\n\n";
				} else {
					chapterContent += "\n\n";
				}
			}

			// Add the processed chapter content to the final output
			finalContent += chapterContent;
		}

		// Remove the last divider and trim whitespace
		if (features.autoInsertDivider) {
			finalContent = finalContent.slice(0, -7);
		}

		return finalContent.replace(/\n{3,}/g, "\n\n").trim();
	}

	private groupSuccessiveHighlights(anno: Annotation[]): SuccessiveGroup[] {
		const groups: SuccessiveGroup[] = [];
		let current: Annotation[] = [];
		let seps: (" " | " [...] ")[] = [];

		for (let i = 0; i < anno.length; i++) {
			const h = anno[i];
			if (current.length) {
				const prev = current[current.length - 1];
				const gap = distanceBetweenHighlights(prev, h);
				seps.push(
					gap <= this.plugin.settings.maxHighlightGap ? " " : " [...] ",
				);
			}
			current.push(h);

			const next = anno[i + 1];
			if (
				!next ||
				!isWithinGap(h, next, this.plugin.settings.maxHighlightGap)
			) {
				groups.push({ annotations: current, separators: seps });
				current = [];
				seps = [];
			}
		}
		return groups;
	}
}
