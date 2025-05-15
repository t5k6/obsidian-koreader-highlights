import { basename } from "node:path";
import type { Annotation, DocProps } from "../types";
import { devLog, devWarn } from "./logging";

export const KOReaderHighlightColors: Record<string, string> = {
    red: "#ff0000",
    orange: "#ff9900",
    yellow: "#ffff00",
    green: "#00ff00",
    olive: "#808000",
    cyan: "#00ffff",
    blue: "#0000ff",
    purple: "#800080",
    gray: "#808080",
};

// Precomputed text colors for each highlight color (light/dark theme optimized)
const KOReaderTextColors: Record<string, { light: string; dark: string }> = {
    red: { light: "#fff", dark: "#fff" },
    orange: { light: "#000", dark: "#fff" },
    yellow: { light: "#000", dark: "#000" },
    green: { light: "#000", dark: "#fff" },
    olive: { light: "#fff", dark: "#fff" },
    cyan: { light: "#000", dark: "#000" },
    blue: { light: "#fff", dark: "#fff" },
    purple: { light: "#fff", dark: "#fff" },
    gray: { light: "#000", dark: "#fff" },
};

const DEFAULT_AUTHOR = "Unknown Author";
const DEFAULT_TITLE = "Untitled";
const FILE_EXTENSION = ".md";
const AUTHOR_SEPARATOR = " & ";
const TITLE_SEPARATOR = " - ";

interface CfiParts {
    fullPath: string; // e.g., /6/14[id6]!/4/2/6/2,/1
    offset: number;
}

// Group 1: Base path (optional, ends with !)
// Group 2: Node steps after !
// Group 3: Text node index (e.g., 1 in /1:28)
// Group 4: Start offset for pos0
// Group 5: End offset for pos0 (optional)
// OR
// Group 6: Text node index for pos1
// Group 7: End offset for pos1
const CFI_REGEX_COMBINED =
    /epubcfi\(([^!]*!)?([^,]+)(?:,\/(\d+):(\d+)(?:\,\/\d+:\d+)?)?(?:,\/(\d+):(\d+))?\)$/;

export function generateObsidianFileName(
    docProps: DocProps,
    highlightsFolder: string,
    originalSdrName?: string,
    maxTotalPathLength = 255,
): string {
    const effectiveAuthor = docProps.authors?.trim();
    const effectiveTitle = docProps.title?.trim();

    let baseName: string;

    const isAuthorEffectivelyMissing = !effectiveAuthor ||
        effectiveAuthor === DEFAULT_AUTHOR;

    const isTitleEffectivelyMissing = !effectiveTitle ||
        effectiveTitle === DEFAULT_TITLE;

    const sdrBaseName = originalSdrName
        ? normalizeFileNamePiece(getFileNameWithoutExt(originalSdrName))
        : undefined;

    if (isAuthorEffectivelyMissing && isTitleEffectivelyMissing) {
        // Case 1: BOTH author and title are missing/default.
        // Use originalSdrName if available, otherwise DEFAULT_TITLE.
        baseName = sdrBaseName || DEFAULT_TITLE;
        devWarn(
            `Using filename based on SDR name or default (author/title missing): ${baseName}`,
        );
    } else if (isAuthorEffectivelyMissing && !isTitleEffectivelyMissing) {
        // Case 2: Author is missing/default, but title IS known.
        // Use only the title.
        baseName = normalizeFileNamePiece(effectiveTitle); // effectiveTitle is guaranteed here
        devWarn(`Using filename based on title (author missing): ${baseName}`);
    } else if (!isAuthorEffectivelyMissing && isTitleEffectivelyMissing) {
        // Case 3: Author IS known, but title is missing/default.
        // Use "Author(s) - OriginalSdrName" if sdrBaseName is available,
        // otherwise "Author(s) - DEFAULT_TITLE".
        const authorArray = (effectiveAuthor || "")
            .split(",")
            .map((author) => normalizeFileNamePiece(author.trim()))
            .filter(Boolean);
        const authorsString = authorArray.join(AUTHOR_SEPARATOR);

        const titleFallback = sdrBaseName || DEFAULT_TITLE;
        baseName = `${authorsString}${TITLE_SEPARATOR}${titleFallback}`;
        devWarn(
            `Using filename based on author and SDR/default title (title missing): ${baseName}`,
        );
    } else {
        // Case 4: BOTH author and title are known and not default.
        // Construct "Author(s) - Title String".
        const authorArray = (effectiveAuthor || "")
            .split(",")
            .map((author) => normalizeFileNamePiece(author.trim()))
            .filter(Boolean);
        const authorsString = authorArray.join(AUTHOR_SEPARATOR);

        const normalizedTitle = normalizeFileNamePiece(effectiveTitle); // effectiveTitle is guaranteed here
        baseName = `${authorsString}${TITLE_SEPARATOR}${normalizedTitle}`;
    }

    // Final safety net: if baseName is somehow empty, use DEFAULT_TITLE.
    if (!baseName?.trim()) {
        baseName = DEFAULT_TITLE;
        devWarn(
            `Filename defaulted to "${DEFAULT_TITLE}" due to empty base after processing.`,
        );
    }
    baseName = normalizeFileNamePiece(baseName);

    const FOLDER_PATH_MARGIN = highlightsFolder.length + 1 + 5;
    const maxLengthForName = maxTotalPathLength - FOLDER_PATH_MARGIN -
        FILE_EXTENSION.length;

    let finalName = baseName;
    if (baseName.length > maxLengthForName) {
        finalName = baseName.slice(0, maxLengthForName);
        devWarn(
            `Filename truncated: "${baseName}${FILE_EXTENSION}" -> "${finalName}${FILE_EXTENSION}" due to path length constraints.`,
        );
    }

    return `${finalName}${FILE_EXTENSION}`;
}

export function normalizeFileNamePiece(
    piece: string | undefined | null,
): string {
    if (!piece) return "";
    // Remove invalid file system characters, trim, replace multiple spaces/underscores
    return piece
        .replace(/[\\/:*?"<>|#%&{}[\]]/g, "_") // More comprehensive removal list
        .replace(/\s+/g, " ") // Consolidate whitespace
        .trim();
}

export function getFileNameWithoutExt(filePath: string | undefined): string {
    if (!filePath) return "";
    const fileName = basename(filePath); // Use basename to get just the file part
    const lastDotIndex = fileName.lastIndexOf(".");
    // If no dot, or dot is the first character (hidden file like .git), return full name
    if (lastDotIndex <= 0) return fileName;
    return fileName.slice(0, lastDotIndex);
}

// Utility to parse pos0/pos1
const positionCache = new Map<string, { node: string; offset: number }>();
export function parsePosition(
    pos: string | undefined,
): { node: string; offset: number } | null {
    if (!pos) return null;
    const cached = positionCache.get(pos);
    if (cached) return cached;

    // Regex to capture base node path and offset
    const match = pos.match(/^(.+)\.(\d+)$/);
    if (!match) {
        // devWarn(`Invalid position format: ${pos}`); // Keep logging minimal if too noisy
        return null;
    }

    const [, node, offsetStr] = match;
    const offset = Number.parseInt(offsetStr, 10);

    if (Number.isNaN(offset)) {
        // devWarn(`Invalid offset in position: ${pos}`);
        return null;
    }

    const result = { node, offset };
    // positionCache.set(pos, result); // Add caching if needed
    return result;
}

export function parseCfi(cfi: string): CfiParts | null {
    const match = cfi.match(CFI_REGEX_COMBINED);

    if (!match) {
        devWarn(`Could not parse CFI: ${cfi}`);
        return null;
    }

    const basePath = match[1] || "";
    const nodeSteps = match[2];

    let textNodeIndexStr: string | undefined;
    let offsetStr: string | undefined;

    if (match[3] !== undefined && match[4] !== undefined) {
        textNodeIndexStr = match[3];
        offsetStr = match[4];
    } else if (match[5] !== undefined && match[6] !== undefined) {
        textNodeIndexStr = match[5];
        offsetStr = match[6];
    } else {
        devWarn(`Could not determine offset structure in CFI: ${cfi}`);
        return null;
    }

    const textNodeIndex = Number.parseInt(textNodeIndexStr, 10);
    const offset = Number.parseInt(offsetStr, 10);

    if (Number.isNaN(offset) || Number.isNaN(textNodeIndex)) {
        devWarn(`Error parsing offset/text node index from CFI: ${cfi}`);
        return null;
    }

    const fullPath = `${basePath}${nodeSteps},/${textNodeIndex}`;

    return {
        fullPath: fullPath,
        offset: offset,
    };
}

export function areHighlightsSuccessive(
    h1: Annotation | undefined,
    h2: Annotation | undefined,
    maxGap = 5,
): boolean {
    if (!h1 || !h2) {
        return false;
    }

    // Must be on the same page
    if (h1.pageno !== h2.pageno) {
        // devLog(`Not successive: different page (${h1.pageno} vs ${h2.pageno})`);
        return false;
    }

    const chapter1 = h1.chapter ?? ""; // Treat undefined as empty string for comparison
    const chapter2 = h2.chapter ?? "";
    if (chapter1 !== chapter2) {
        // devLog(`Not successive: different chapter ('${chapter1}' vs '${chapter2}')`);
        return false;
    }

    // Parse end position of h1 and start position of h2
    const pos1_end = parsePosition(h1.pos1);
    const pos2_start = parsePosition(h2.pos0);

    // If positions are invalid, cannot determine succession based on position
    if (!pos1_end || !pos2_start) {
        // devLog(`Not successive: invalid positions h1.pos1=${h1.pos1} or h2.pos0=${h2.pos0}`);
        return false;
    }

    // Must be within the same base node (e.g., same paragraph text node)
    if (pos1_end.node !== pos2_start.node) {
        // devLog(`Not successive: different nodes (${pos1_end.node} vs ${pos2_start.node})`);
        return false;
    }

    // Check if the start of the second highlight is before or slightly after the end of the first.
    // This handles adjacency (gap=1), exact continuation (gap=0), overlap (gap < 0),
    // and small gaps (gap <= maxGap).
    const isPositionalSuccessive =
        pos2_start.offset <= pos1_end.offset + maxGap;

    // devLog(`Successive Check: h1(end=${pos1_end.offset}) vs h2(start=${pos2_start.offset}). Condition: ${pos2_start.offset} <= ${pos1_end.offset + maxGap}. Result: ${isPositionalSuccessive}`);

    return isPositionalSuccessive;
}

export function compareAnnotations(a: Annotation, b: Annotation): number {
    if (!a || !b) return 0;
    if (a.pageno !== b.pageno) return a.pageno - b.pageno;
    if ((a.chapter ?? "") !== (b.chapter ?? "")) {
        return (a.chapter ?? "").localeCompare(b.chapter ?? "");
    }
    const aPos0 = a.pos0;
    const bPos0 = b.pos0;
    if (aPos0 && bPos0) {
        if (aPos0 !== bPos0) return aPos0.localeCompare(bPos0);
    } else if (aPos0) return -1; // Sort annotations with position first
    else if (bPos0) return 1;

    // Fallback to datetime
    const dateA = a.datetime ? new Date(a.datetime).getTime() : 0;
    const dateB = b.datetime ? new Date(b.datetime).getTime() : 0;
    if (Number.isNaN(dateA) || Number.isNaN(dateB)) return 0;
    return dateA - dateB;
}

// Group annotations by paragraph proximity
function groupAnnotationsByParagraph(
    annotations: Annotation[],
    maxTimeGapMinutes = 10,
): Annotation[][] {
    if (!annotations.length) return [];

    // Single sort by page, position, and datetime
    const sorted = [...annotations].sort(compareAnnotations);

    devLog(
        `Sorted annotations: ${
            sorted.map((h) =>
                `text="${h.text}", pos0=${h.pos0}, pos1=${h.pos1}`
            ).join(" | ")
        }`,
    );

    const groups: Annotation[][] = [];
    let currentGroup: Annotation[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const prev = currentGroup[currentGroup.length - 1];
        const curr = sorted[i];
        const timeDiff = (new Date(curr.datetime).getTime() -
            new Date(prev.datetime).getTime()) / (1000 * 60);

        if (
            areHighlightsSuccessive(prev, curr, 5) &&
            timeDiff <= maxTimeGapMinutes
        ) {
            currentGroup.push(curr);
            devLog(
                `Added to group: ${curr.text} (pos0=${curr.pos0}, pos1=${curr.pos1})`,
            );
        } else {
            groups.push(currentGroup);
            devLog(
                `New group started with: ${curr.text} (pos0=${curr.pos0}, pos1=${curr.pos1})`,
            );
            currentGroup = [curr];
        }
    }
    if (currentGroup.length) {
        groups.push(currentGroup);
        devLog(`Final group: ${currentGroup.map((h) => h.text).join(" | ")}`);
    }

    return groups;
}

// Deduplicate overlapping highlights
function deduplicateOverlaps(group: Annotation[]): Annotation[] {
    if (group.length <= 1) return group;

    const deduplicated: Annotation[] = [];
    const processedRanges: { start: number; end: number }[] = [];

    for (const highlight of group) {
        const pos0 = parsePosition(highlight.pos0);
        const pos1 = parsePosition(highlight.pos1);
        if (!pos0 || !pos1 || !highlight.text) {
            devLog(
                `Skipping highlight with invalid positions or text: ${highlight.text}`,
            );
            continue;
        }

        // Check if highlight is fully covered by any processed range
        const isFullyCovered = processedRanges.some((range) =>
            pos0.offset >= range.start && pos1.offset <= range.end
        );

        if (!isFullyCovered) {
            deduplicated.push({ ...highlight });
            processedRanges.push({ start: pos0.offset, end: pos1.offset });
            devLog(
                `Kept highlight: ${highlight.text} (pos0=${pos0.offset}, pos1=${pos1.offset})`,
            );
        } else {
            devLog(
                `Skipped fully overlapped highlight: ${highlight.text} (pos0=${pos0.offset}, pos1=${pos1.offset})`,
            );
        }
    }

    return deduplicated.filter((h) => h.text && h.text.trim().length > 0);
}

function formatHighlightGroup(
    group: Annotation[],
    isFirstInChapter: boolean,
): string {
    if (!group.length) return "";

    // Deduplicate overlaps
    const deduplicatedGroup = deduplicateOverlaps(group);

    // Use earliest datetime, shared page, and consistent chapter
    const earliestDate = deduplicatedGroup.reduce((min, h) => {
        const d = new Date(h.datetime);
        return !min || d < min ? d : min;
    }, null as Date | null);
    const pageno = deduplicatedGroup[0].pageno;
    const header = `*${
        formatDate(earliestDate?.toISOString() || deduplicatedGroup[0].datetime)
    } - Page ${pageno}*\n\n`;

    const sortedGroup = [...deduplicatedGroup].sort((a, b) => {
        const posA = parsePosition(a.pos0);
        const posB = parsePosition(b.pos0);
        if (!posA || !posB) return 0;
        return posA.offset - posB.offset;
    });

    // Combine highlighted text with individual styling
    const isDarkTheme = typeof document !== "undefined" &&
        document.documentElement.getAttribute("data-theme") === "dark";

    let highlightedText = "";
    for (let i = 0; i < sortedGroup.length; i++) {
        const highlight = sortedGroup[i];
        const drawer = highlight.drawer || "lighten";
        const colorName = highlight.color?.toLowerCase()?.trim() || "";
        const colorHex = KOReaderHighlightColors[colorName] ||
            highlight.color || null;

        let text = highlight.text || "";

        if (i > 0) {
            text = ` ${text}`;
        }

        if (colorName === "gray" || colorHex === "#808080") {
            highlightedText += text;
        } else if (drawer === "lighten" && colorHex) {
            const textColor = getContrastTextColor(
                colorName || colorHex,
                isDarkTheme,
            );
            highlightedText +=
                `<mark style="background-color: ${colorHex}; color: ${textColor}">${text}</mark>`;
        } else if (drawer === "underscore") {
            highlightedText += `<u>${text}</u>`;
        } else if (drawer === "strikeout") {
            highlightedText += `<s>${text}</s>`;
        } else if (drawer === "invert" && colorHex) {
            const textColor = getContrastTextColor(colorHex, isDarkTheme);
            highlightedText +=
                `<mark style="background-color: ${textColor}; color: ${colorHex}">${text}</mark>`;
        } else {
            highlightedText += text;
        }
    }

    // Combine notes
    const noteSection = sortedGroup
        .filter((h) => h.note)
        .map((highlight) =>
            `\n\n> [!NOTE] Note\n${
                highlight.note?.split("\n").map((line) => `> ${line.trim()}`)
                    .join("\n")
            }`
        )
        .join("\n");

    devLog(`Formatted group: ${highlightedText}`);
    return `${header}${highlightedText}${noteSection}\n\n---\n`;
}

export function formatAllHighlights(annotations: Annotation[]): string {
    // Group annotations by chapter
    const groupedByChapter = annotations.reduce((acc, annotation) => {
        const chapter = annotation.chapter || "Uncategorized";
        if (!acc[chapter]) {
            acc[chapter] = [];
        }
        acc[chapter].push(annotation);
        return acc;
    }, {} as Record<string, Annotation[]>);

    let result = "";

    // Iterate over chapters and format their highlights
    for (
        const [chapter, chapterHighlights] of Object.entries(groupedByChapter)
    ) {
        // Add chapter header (only once per chapter)
        if (chapter && chapter !== "Uncategorized") {
            result += `## ${chapter}\n\n`;
        }

        // Format all highlights under this chapter
        for (const highlight of chapterHighlights) {
            result += `- ${highlight.text}\n`;
            if (highlight.note) {
                result += `  > ${highlight.note}\n`;
            }
        }

        // Add a separator between chapters
        result += "\n---\n\n";
    }

    return result;
}

export function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function secondsToHoursMinutes(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

export function formatUnixTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function formatPercent(percent: number): string {
    return `${Math.round(percent)}%`;
}

function hexToRgb(hex: string): [number, number, number] | null {
    const match = hex.replace("#", "").match(/.{1,2}/g);
    if (!match || match.length < 3) return null;
    return [
        Number.parseInt(match[0], 16),
        Number.parseInt(match[1], 16),
        Number.parseInt(match[2], 16),
    ];
}

function luminance([r, g, b]: [number, number, number]): number {
    const a = [r, g, b].map((v) => {
        const normalized = v / 255;
        return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

export function getContrastTextColor(
    bgColor: string,
    isDarkTheme: boolean,
): string {
    if (!bgColor) return isDarkTheme ? "#fff" : "#222";

    const lowerColor = bgColor.toLowerCase();
    if (KOReaderTextColors[lowerColor]) {
        return isDarkTheme
            ? KOReaderTextColors[lowerColor].dark
            : KOReaderTextColors[lowerColor].light;
    }

    const colorHex = KOReaderHighlightColors[lowerColor] || bgColor;
    if (!colorHex.startsWith("#")) return isDarkTheme ? "#fff" : "#222";

    const rgb = hexToRgb(colorHex);
    if (!rgb) return isDarkTheme ? "#fff" : "#222";

    const lum = luminance(rgb);
    return lum > 0.5 ? "#222" : "#fff";
}
