import { parse } from "node:path";
import type { Annotation } from "../types";
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

interface PositionObject {
    x: number;
    y: number;
}

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
    docProps: { title?: string; authors?: string },
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

    if (!isAuthorEffectivelyMissing && !isTitleEffectivelyMissing) {
        // Case 1: BOTH author and title are known and not default.
        const authorArray = (effectiveAuthor || "")
            .split(",")
            .map((author) => normalizeFileNamePiece(author.trim()))
            .filter(Boolean);
        const authorsString = authorArray.join(AUTHOR_SEPARATOR);
        const normalizedTitle = normalizeFileNamePiece(effectiveTitle);
        baseName = `${authorsString}${TITLE_SEPARATOR}${normalizedTitle}`;
    } else if (!isAuthorEffectivelyMissing) {
        // Case 2: Author is known, but title is missing.
        const authorArray = (effectiveAuthor || "")
            .split(",")
            .map((author) => normalizeFileNamePiece(author.trim()))
            .filter(Boolean);
        const authorsString = authorArray.join(AUTHOR_SEPARATOR);
        const titleFallback = sdrBaseName
            ? simplifySdrName(sdrBaseName)
            : DEFAULT_TITLE;
        baseName = `${authorsString}${TITLE_SEPARATOR}${titleFallback}`;
        devWarn(
            `Using filename based on author and SDR/default title: ${baseName}`,
        );
    } else if (!isTitleEffectivelyMissing) {
        // Case 3: Title is known, but author is missing.
        baseName = normalizeFileNamePiece(effectiveTitle);
        devWarn(`Using filename based on title (author missing): ${baseName}`);
    } else {
        // Case 4: BOTH are missing. Use ONLY the original SDR name (skip docProps.authors entirely).
        baseName = sdrBaseName ? simplifySdrName(sdrBaseName) : DEFAULT_TITLE;
        devWarn(
            `Using cleaned SDR name (author/title missing): ${baseName}`,
        );
    }

    // Final safety net: if baseName is somehow empty, use DEFAULT_TITLE.
    if (!baseName?.trim()) {
        baseName = DEFAULT_TITLE;
        devWarn(
            `Filename defaulted to "${DEFAULT_TITLE}" due to empty base after processing.`,
        );
    }

    const FOLDER_PATH_MARGIN = highlightsFolder.length + 1 + 5;
    const maxLengthForName = maxTotalPathLength - FOLDER_PATH_MARGIN -
        FILE_EXTENSION.length;

    if (maxLengthForName <= 0) {
        devWarn(
            `highlightsFolder path is too long; falling back to default file name.`,
        );
        return DEFAULT_TITLE + FILE_EXTENSION;
    }

    let finalName = baseName;
    if (baseName.length > maxLengthForName) {
        finalName = baseName.slice(0, maxLengthForName);
        devWarn(
            `Filename truncated: "${baseName}${FILE_EXTENSION}" -> "${finalName}${FILE_EXTENSION}" due to path length constraints.`,
        );
    }

    const fullPath = `${highlightsFolder}/${finalName}${FILE_EXTENSION}`;
    devWarn(`Full path length: ${fullPath.length}, Path: ${fullPath}`);

    return `${finalName}${FILE_EXTENSION}`;
}

/**
 * Collapse all the Koreader "SDR" to something that looks like
 * a human filename.                           ─────────────────────────────
 *
 * 1.  Removes the leading "(Series-X)" block if it exists.
 * 2.  Deletes duplicate *tokens* (A – B – C – A   →   A – B – C)
 * 3.  Deletes duplicate *blocks* (A – B – C – A – B – C   →   A – B – C)
 *
 * The whole routine is case-insensitive, keeps the first spelling it
 * encounters and preserves the original " ⸺  -  " separator.
 */
export function simplifySdrName(raw: string, delimiter = " - "): string {
    if (!raw) {
        return "";
    }

    // ── 0. Strip a prepended "(……)" leader
    raw = raw.replace(/^\([^)]*\)\s*/, "").trim();

    const parts = raw.split(delimiter).map((p) => p.trim()).filter(Boolean);

    // ── 1. Drop REPEATED TOKENS  (case-insensitive)
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const p of parts) {
        const key = p.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            uniq.push(p);
        }
    }

    // ── 2. Drop REPEATED BLOCKS  (A B C  A B C  →  A B C)
    let tokens = [...uniq];
    let changed = true;

    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

    while (changed) {
        changed = false;

        for (let block = Math.floor(tokens.length / 2); block >= 1; block--) {
            // slide a window over the list; whenever we see  [X…] [X…]  collapse it
            outer: for (let i = 0; i + 2 * block <= tokens.length; i++) {
                for (let j = 0; j < block; j++) {
                    if (!same(tokens[i + j], tokens[i + block + j])) {
                        continue outer; // not identical → keep looking
                    }
                }
                // Found a duplicate block – delete the second copy
                tokens.splice(i + block, block);
                changed = true;
                break;
            }
            if (changed) break; // restart with the (possibly) shorter array
        }
    }

    return tokens.join(delimiter) || "Untitled";
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
    return parse(filePath).name;
}

// Type guard function
function isPositionObject(obj: any): obj is PositionObject {
    return obj && typeof obj === "object" && "x" in obj && "y" in obj;
}

// Utility to parse pos0/pos1
const positionCache = new Map<string, { node: string; offset: number }>();
export function parsePosition(
    pos: string | PositionObject | undefined,
): { node: string; offset: number } | null {
    if (!pos) return null;

    // Handle the new position format with x/y coordinates
    if (isPositionObject(pos)) {
        // Create a unique identifier based on coordinates
        const node = `coord_${Math.round(pos.x)}_${Math.round(pos.y)}`;
        return { node, offset: 0 };
    }

    // Existing string parsing logic
    if (typeof pos === "string") {
        const match = pos.match(/^(.+)\.(\d+)$/);
        if (!match) return null;

        const [, node, offsetStr] = match;
        const offset = Number.parseInt(offsetStr, 10);
        return Number.isNaN(offset) ? null : { node, offset };
    }

    return null;
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
    maxGap = 250,
): boolean {
    if (!h1 || !h2) return false;
    if (h1.pageno !== h2.pageno) return false;

    // Handle coordinate-based positions
    if (isPositionObject(h1.pos0) && isPositionObject(h2.pos0)) {
        // Simple vertical proximity check
        return Math.abs(h1.pos0.y - h2.pos0.y) < 50;
    }

    // Existing string-based position logic
    const pos1_end = parsePosition(h1.pos1);
    const pos2_start = parsePosition(h2.pos0);

    if (!pos1_end || !pos2_start || pos1_end.node !== pos2_start.node) {
        return false;
    }

    return pos2_start.offset - pos1_end.offset <= maxGap;
}

export function compareAnnotations(a: Annotation, b: Annotation): number {
    if (!a || !b) return 0;

    // Primary sort: page number
    if (a.pageno !== b.pageno) {
        return a.pageno - b.pageno;
    }

    // Secondary sort: character position on the page.
    const posA = parsePosition(a.pos0);
    const posB = parsePosition(b.pos0);

    if (posA && posB) {
        if (posA.node !== posB.node) {
            return posA.node.localeCompare(posB.node);
        }
        if (posA.offset !== posB.offset) {
            return posA.offset - posB.offset;
        }
    } else if (posA) {
        return -1;
    } else if (posB) {
        return 1;
    }

    // Fallback sort: datetime, for identical positions.
    try {
        const dateA = new Date(a.datetime).getTime();
        const dateB = new Date(b.datetime).getTime();
        if (!isNaN(dateA) && !isNaN(dateB)) {
            return dateA - dateB;
        }
    } catch (e) {
        // ignore invalid date formats
    }

    return 0;
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
        .map((highlight) => {
            const noteLines = highlight.note
                ?.split("\n")
                .map((line) => `> ${line}`) // do NOT trim, preserve spaces
                .join("\n");
            return `\n\n> [!NOTE] Note\n${noteLines}`;
        })
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

export function secondsToHoursMinutesSeconds(totalSeconds: number): string {
    if (totalSeconds < 0) totalSeconds = 0;

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    let result = "";
    if (hours > 0) {
        result += `${hours}h `;
    }
    if (minutes > 0 || hours > 0) { // Show minutes if hours are present or minutes > 0
        result += `${minutes}m `;
    }

    if (seconds > 0 || result === "") { // If result is empty, means 0h 0m, so just show seconds.
        result += `${seconds}s`;
    }

    result = result.trim(); // Remove trailing space if seconds is 0 and others are present

    return result === "" ? "0s" : result; // Handle case of exactly 0 seconds
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

export function styleHighlight(
    text: string,
    color?: string,
    drawer?: Annotation["drawer"],
    isDarkTheme = false,
): string {
    if (!text || text.trim() === "") {
        devWarn("Skipping empty highlight text");
        return "";
    }

    const lowerColor = color?.toLowerCase().trim();
    const colorHex: string | null = lowerColor != null
        ? KOReaderHighlightColors[lowerColor] ?? color ?? null
        : null;

    // ───────────────────────────── drawers ──────────────────────────────
    switch (drawer) {
        case "underscore":
            return `<u>${text}</u>`;

        case "strikeout":
            return `<s>${text}</s>`;

        case "invert":
            return createInvertedHighlight(text, colorHex, isDarkTheme);

        case "lighten":
            // Only bypass styling for grey color
            if (colorHex === "#808080" || lowerColor === "gray") {
                return text;
            }
            return createStandardHighlight(text, colorHex, isDarkTheme);

        default:
            return createStandardHighlight(text, colorHex, isDarkTheme);
    }
}

function createInvertedHighlight(
    text: string,
    colorHex: string | null,
    isDarkTheme: boolean,
): string {
    if (!colorHex) return text;

    const textColor = getContrastTextColor(colorHex, isDarkTheme);
    // Swap fg/bg compared to "standard" highlight
    return createStyledMark(text, "transparent", textColor);
}

function createStandardHighlight(
    text: string,
    colorHex: string | null,
    isDarkTheme: boolean,
): string {
    if (!colorHex) return text; // grey or unknown colours remain raw

    const textColor = getContrastTextColor(colorHex, isDarkTheme);
    return createStyledMark(text, colorHex, textColor);
}

function createStyledMark(
    text: string,
    backgroundColor: string,
    textColor: string,
): string {
    return `<mark style="background-color: ${backgroundColor}; color: ${textColor};">${text}</mark>`;
}
