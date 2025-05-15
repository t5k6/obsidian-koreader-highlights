import type {
    Annotation,
    KoReaderHighlightImporterSettings,
    LuaMetadata,
} from "../types";
import {
    areHighlightsSuccessive,
    compareAnnotations,
    formatDate,
    getContrastTextColor,
    KOReaderHighlightColors,
    parsePosition,
} from "../utils/formatUtils";
import type { TemplateManager } from "./TemplateManager";

function sortChaptersNaturally(a: string, b: string): number {
    const strA = a || "";
    const strB = b || "";

    return strA.localeCompare(strB, undefined, {
        numeric: true,
        sensitivity: "base",
    });
}

export class ContentGenerator {
    constructor(
        private templateManager: TemplateManager,
        private settings: KoReaderHighlightImporterSettings,
    ) {}

    async generateHighlightsContent(
        annotations: Annotation[],
        luaMetadata: LuaMetadata,
    ): Promise<string> {
        if (!annotations || annotations.length === 0) {
            return "";
        }

        const templateString = await this.templateManager.loadTemplate();

        // 1. Sort annotations first by page, then position/date (using the existing compareAnnotations)
        const sortedAnnotations = [...annotations].sort(compareAnnotations);

        // 2. Group by chapter
        const groupedByChapter = sortedAnnotations.reduce((acc, highlight) => {
            const chapter = highlight.chapter?.trim() || "Chapter Unknown";
            if (!acc[chapter]) {
                acc[chapter] = [];
            }
            acc[chapter].push(highlight);
            return acc;
        }, {} as Record<string, Annotation[]>);

        let finalContent = "";
        const chapterNames = Object.keys(groupedByChapter);
        const sortedChapterNames = chapterNames.sort(sortChaptersNaturally);

        let isFirstChapterProcessed = true;
        for (const chapter of sortedChapterNames) {
            const chapterHighlights = groupedByChapter[chapter];
            if (!chapterHighlights || chapterHighlights.length === 0) continue;

            if (!isFirstChapterProcessed) {
                finalContent += "\n\n";
            }

            let isFirstHighlightInChapter = true;

            // 3. Group successive highlights WITHIN the already sorted chapterHighlights
            const groupedSuccessiveHighlights = this.groupSuccessiveHighlights(
                chapterHighlights,
            );

            // 4. Render each highlight block within the chapter
            for (const highlightGroup of groupedSuccessiveHighlights) {
                if (!isFirstHighlightInChapter) {
                    finalContent += "\n\n---\n";
                }

                if (highlightGroup.length === 1) {
                    const highlight = highlightGroup[0];
                    const data = {
                        pageno: highlight.pageno ?? 0,
                        date: formatDate(highlight.datetime),
                        highlight: highlight.text ?? "",
                        note: highlight.note ?? "",
                        chapter: chapter !== "Chapter Unknown" ? chapter : "",
                        isFirstInChapter: isFirstHighlightInChapter,
                    };
                    finalContent += this.templateManager.renderHighlight(
                        templateString,
                        data,
                        highlight.color,
                        highlight.drawer,
                    );
                } else {
                    const representativeHighlight = highlightGroup[0];
                    const combinedStyledText = this.combineGroupedHighlightText(
                        highlightGroup,
                    );

                    const data = {
                        pageno: representativeHighlight.pageno ?? 0,
                        date: formatDate(representativeHighlight.datetime),
                        highlight: combinedStyledText,
                        note: representativeHighlight.note ?? "",
                        chapter: chapter !== "Chapter Unknown" ? chapter : "",
                        isFirstInChapter: isFirstHighlightInChapter,
                    };
                    finalContent += this.templateManager.renderHighlight(
                        templateString,
                        data,
                    );
                }

                isFirstHighlightInChapter = false;
            }

            isFirstChapterProcessed = false;
        }

        return finalContent.replace(/\n{3,}/g, "\n\n").trim();
    }

    private groupSuccessiveHighlights(
        chapterHighlights: Annotation[],
    ): Annotation[][] {
        if (!chapterHighlights || chapterHighlights.length === 0) return [];

        const groups: Annotation[][] = [];
        let currentGroup: Annotation[] = [];

        for (let i = 0; i < chapterHighlights.length; i++) {
            const current = chapterHighlights[i];
            currentGroup.push(current);

            const next = chapterHighlights[i + 1];
            if (
                !next ||
                !areHighlightsSuccessive(
                    current,
                    next,
                    this.settings.maxHighlightGap,
                )
            ) {
                groups.push([...currentGroup]);
                currentGroup = [];
            }
        }

        return groups;
    }

    private combineGroupedHighlightText(group: Annotation[]): string {
        if (!group || group.length === 0) return "";

        const sortedGroup = [...group].sort((a, b) => {
            const posA = parsePosition(a.pos0);
            const posB = parsePosition(b.pos0);
            if (!posA && !posB) return 0;
            if (!posA) return -1;
            if (!posB) return 1;
            return posA.offset - posB.offset;
        });

        let combinedText = "";
        const isDark = document.body.classList.contains("theme-dark");

        for (let i = 0; i < sortedGroup.length; i++) {
            const h = sortedGroup[i];
            let segmentText = h.text || "";

            if (i > 0) {
                const prev = sortedGroup[i - 1];
                const posPrev = parsePosition(prev.pos1);
                const posCurr = parsePosition(h.pos0);

                const gap =
                    (posPrev && posCurr && posPrev.node === posCurr.node)
                        ? posCurr.offset - posPrev.offset
                        : 1;

                if (gap > 0 && gap <= (this.settings.maxHighlightGap * 2)) {
                    combinedText += " ";
                } else if (gap > (this.settings.maxHighlightGap * 2)) {
                    combinedText += " [...] ";
                }
            }

            // Apply styling based on this segment's color/drawer
            const lowerColor = h.color?.toLowerCase().trim();
            const colorHex = lowerColor
                ? (KOReaderHighlightColors[lowerColor] || h.color)
                : null;

            switch (h.drawer) {
                case "underscore":
                    segmentText = `<u>${segmentText}</u>`;
                    break;
                case "strikeout":
                    segmentText = `<s>${segmentText}</s>`;
                    break;
                case "invert":
                    if (colorHex && lowerColor !== "gray") {
                        const textColor = getContrastTextColor(
                            colorHex,
                            isDark,
                        );
                        segmentText =
                            `<mark style="background-color: ${textColor}; color: ${colorHex}">${segmentText}</mark>`;
                    }
                    break;
                default: // lighten or default
                    if (colorHex && lowerColor !== "gray") {
                        const textColor = getContrastTextColor(
                            colorHex,
                            isDark,
                        );
                        segmentText =
                            `<mark style="background-color: ${colorHex}; color: ${textColor}">${segmentText}</mark>`;
                    }
                    break;
            }

            combinedText += segmentText;
        }

        return combinedText;
    }
}
