import type {
	Annotation,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
} from "../types";
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
		private settings: KoreaderHighlightImporterSettings,
	) {}

	async generateHighlightsContent(
		annotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<string> {
		if (!annotations || annotations.length === 0) {
			return "";
		}

		const templateString = await this.templateManager.loadTemplate();

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

				// Sort the highlights within this chapter to find the earliest one.
				sortedHighlights.forEach((ann) => {
					ann.chapter = chapterName;
				});
				// The chapter's order is determined by its first highlight's page number.
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
		let isFirstChapterProcessed = true;
		for (const chapterData of chaptersToSort) {
			const chapterHighlights = chapterData.annotations;
			if (!chapterHighlights || chapterHighlights.length === 0) continue;

			if (!isFirstChapterProcessed) {
				finalContent += "\n\n";
			}

			let isFirstHighlightInChapter = true;

			// Group successive highlights within the already sorted chapter.
			const groupedSuccessiveHighlights =
				this.groupSuccessiveHighlights(chapterHighlights);

			// Render each highlight block within the chapter.
			for (const highlightGroup of groupedSuccessiveHighlights) {
				finalContent += this.templateManager.renderGroup(
					templateString,
					highlightGroup.annotations,
					{
						separators: highlightGroup.separators,
						isFirstInChapter: isFirstHighlightInChapter,
					},
				);
				isFirstHighlightInChapter = false;

				// divider between groups inside the chapter
				if (!isFirstHighlightInChapter) {
					if (this.templateManager.shouldAutoInsertDivider()) {
						finalContent += "\n\n---\n\n";
					} else {
						// If the template has its own divider, we still add spacing.
						finalContent += "\n\n";
					}
				}
			}

			isFirstChapterProcessed = false;
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
				seps.push(gap <= this.settings.maxHighlightGap ? " " : " [...] ");
			}
			current.push(h);

			const next = anno[i + 1];
			if (!next || !isWithinGap(h, next, this.settings.maxHighlightGap)) {
				groups.push({ annotations: current, separators: seps });
				current = [];
				seps = [];
			}
		}
		return groups;
	}
}
