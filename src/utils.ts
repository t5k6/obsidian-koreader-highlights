import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join as node_join } from "node:path";
import {
    normalizePath,
    Notice,
    type TFile,
    TFolder,
    type Vault,
} from "obsidian";
import { type Annotation, DEFAULT_SETTINGS, type DocProps } from "./types";

let isDebugMode = false;
let logFilePath: string;
let logFile: TFile | null = null;
let logVault: Vault;

const KOReaderHighlightColors: Record<string, string> = {
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

const formattedDate = getFormattedDate();

/**
 * DebugLevel enumeration for controlling the verbosity of debug messages.
 */
enum DebugLevel {
    NONE = 0,
    INFO = 1,
    WARNING = 2,
    ERROR = 3,
}

/* Global variable to store the current debug level.
   Defaults to NONE so no debug logs are printed. */
let currentDebugLevel: DebugLevel = DebugLevel.NONE;

/**
 * Set the current debug level.
 * @param level - The debug level to set: NONE, ERROR, WARNING, or INFO.
 */
export function setDebugLevel(level: DebugLevel): void {
    currentDebugLevel = level;
}

/**
 * Logs information messages if the current debug level is INFO.
 */
export function devLog(...args: unknown[]): void {
    console.log(
        `[Debug Check] Current level is: ${currentDebugLevel}, Required: ${DebugLevel.INFO}`,
    );

    if (currentDebugLevel >= DebugLevel.INFO) {
        console.log(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "INFO");
    }
}

/**
 * Logs warning messages if the current debug level is WARNING or above.
 */
export function devWarn(...args: string[]): void {
    if (currentDebugLevel >= DebugLevel.WARNING) {
        console.warn(...args);
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "WARNING");
    }
}

/**
 * Logs error messages if the current debug level is ERROR or above.
 */
export function devError(...args: unknown[]): void {
    if (currentDebugLevel >= DebugLevel.ERROR) {
        console.error(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "ERROR");
    }
}

function getFormattedDate(): string {
    const date = new Date();
    return date.toISOString()
        .replace(/[:.]/g, "-") // Replace colons and periods with hyphens
        .replace("T", "_"); // Replace the 'T' in ISO format with an underscore
}

export async function initLogging(
    vault: Vault,
    logFolderPath: string,
): Promise<string> {
    logVault = vault;
    const logDir = normalizePath(logFolderPath);

    try {
        const folder = vault.getAbstractFileByPath(logDir);

        if (!folder || !(folder instanceof TFolder)) {
            await vault.createFolder(logDir);
        }
    } catch (error) {
        if ((error as Error).message !== "Folder already exists.") {
            console.error("Failed to create or access log folder:", error);
            throw error;
        }
        console.log(`Log folder already exists: ${logDir}`);
    }

    logFilePath = normalizePath(
        `${logDir}/koreader-importer_${formattedDate}.md`,
    );

    logFile = await vault.create(
        logFilePath,
        `Log initialized at ${new Date().toISOString()}\n`,
    );

    return logFilePath;
}

export async function writeLog(
    message: string,
    level: "INFO" | "WARNING" | "ERROR",
): Promise<void> {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;

    if (logFile) {
        try {
            await logVault.modify(
                logFile,
                (await logVault.read(logFile)) + logEntry,
            );
        } catch (error) {
            console.error("Failed to append to log file:", error);
        }
    } else {
        console.error(
            "Log file not initialized. Cannot write log entry:",
            logEntry,
        );
    }
}

export function setDebugMode(debugMode: boolean) {
    isDebugMode = debugMode;
    if (debugMode) {
        setDebugLevel(DebugLevel.INFO);
    } else {
        setDebugLevel(DebugLevel.NONE);
    }
}

export async function generateUniqueFilePath(
    vault: Vault,
    baseDir: string,
    fileName: string,
    maxFileNameLength?: number,
): Promise<string> {
    const normalizedBaseDir = normalizePath(baseDir);
    let normalizedFileName = normalizePath(fileName);

    if (maxFileNameLength && normalizedFileName.length > maxFileNameLength) {
        const ext = normalizedFileName.substring(
            normalizedFileName.lastIndexOf("."),
        );
        const baseName = normalizedFileName.substring(
            0,
            normalizedFileName.lastIndexOf("."),
        );
        normalizedFileName = `${
            baseName.slice(0, maxFileNameLength - ext.length)
        }${ext}`;
    }

    let counter = 1;
    let newPath = normalizePath(`${normalizedBaseDir}/${normalizedFileName}`);
    const baseName = normalizedFileName.substring(
        0,
        normalizedFileName.lastIndexOf("."),
    );
    const ext = normalizedFileName.substring(
        normalizedFileName.lastIndexOf("."),
    );

    while (vault.getAbstractFileByPath(newPath)) {
        newPath = normalizePath(
            `${normalizedBaseDir}/${baseName} (${counter})${ext}`,
        );
        counter++;
    }

    return newPath;
}

export async function ensureParentDirectory(
    vault: Vault,
    filePath: string,
): Promise<void> {
    const dirPath = normalizePath(
        filePath.substring(0, filePath.lastIndexOf("/")),
    );
    const dirExists = vault.getFolderByPath(dirPath);

    if (!dirExists) {
        await vault.createFolder(dirPath);
    }
}

export async function findAndReadMetadataFile(
    directory: string,
    allowedFileTypes: string[],
): Promise<string | null> {
    const isFileTypeFilterEmpty = !allowedFileTypes.length ||
        (allowedFileTypes.length === 1 && !allowedFileTypes[0]);

    const searchFiles = async (files: string[]) => {
        for (const file of files) {
            if (isFileTypeFilterEmpty && /^metadata\..+\.lua$/.test(file)) {
                const luaFilePath = node_join(directory, file);
                try {
                    const stats = await stat(luaFilePath);
                    if (stats.isFile()) {
                        devLog(`File found: ${luaFilePath}`);
                        return await readFile(luaFilePath, "utf-8");
                    }
                    devWarn(`Skipping non-file: ${luaFilePath}`);
                } catch (error) {
                    const e = error as NodeJS.ErrnoException;
                    await handleDirectoryError(luaFilePath, e);
                }
            } else if (
                !isFileTypeFilterEmpty &&
                allowedFileTypes.some((type) => file === `metadata.${type}.lua`)
            ) {
                const luaFilePath = node_join(directory, file);
                try {
                    const stats = await stat(luaFilePath);
                    if (stats.isFile()) {
                        devLog(`File found: ${luaFilePath}`);
                        return await readFile(luaFilePath, "utf-8");
                    }
                    devWarn(`Skipping non-file: ${luaFilePath}`);
                } catch (error) {
                    const e = error as NodeJS.ErrnoException;
                    await handleDirectoryError(luaFilePath, e);
                }
            }
        }
        return null;
    };

    try {
        const files = await readdir(directory);
        return searchFiles(files);
    } catch (error) {
        devError(`Error reading directory ${directory}:`, error);
        return null;
    }
}

export function generateFileName(
    docProps: DocProps,
    highlightsFolder: string,
): string {
    const authors = docProps.authors || "Unknown Author";
    const title = docProps.title || "Untitled";
    const normalizedAuthors = normalizeFileName(authors);
    const normalizedTitle = normalizeFileName(title);
    const authorsArray = normalizedAuthors.split(",").map((author) =>
        author.trim()
    );
    const authorsString = authorsArray.join(" & ") || "Unknown Author";
    const fileName = `${authorsString} - ${normalizedTitle}.md`;

    const maxFileNameLength = 260 - highlightsFolder.length - 1 - 4; // 4 for '.md'
    return fileName.length > maxFileNameLength
        ? `${fileName.slice(0, maxFileNameLength)}.md`
        : fileName;
}

function normalizeFileName(fileName: string): string {
    return fileName.replace(/[\\/:*?"<>|]/g, "_").trim();
}

export function getFileNameWithoutExt(filePath: string): string {
    const fileName = basename(filePath);
    const lastDotIndex = fileName.lastIndexOf(".");
    return lastDotIndex === -1 ? fileName : fileName.slice(0, lastDotIndex);
}

function formatMessage(arg: unknown): string {
    if (arg instanceof Error) {
        return arg.message;
    }
    if (typeof arg === "object" && arg !== null) {
        return JSON.stringify(arg, null, 2);
    }
    return String(arg);
}

export async function handleDirectoryError(
    filePath: string,
    error: NodeJS.ErrnoException,
) {
    switch (error.code) {
        case "ENOENT":
            devError(`File/Directory not found: ${filePath}`);
            new Notice(`File/Directory not found: ${filePath}`);
            break;
        case "EPERM":
            devError(`Permission denied for file/directory: ${filePath}`);
            break;
        case "EACCES":
            devError(`Access denied for file/directory: ${filePath}`);
            break;
        default:
            devError(`Error reading file/directory ${filePath}:`, error);
    }
}

// Utility to parse pos0/pos1
const positionCache = new Map<string, { node: string; offset: number }>();
function parsePosition(pos: string | undefined) {
    if (!pos) return null;
    const cached = positionCache.get(pos);
    if (cached) return cached;
    const match = pos.match(/^(.+)\.(\d+)$/);
    if (!match) {
        devWarn(`Invalid position format: ${pos}`);
        return null;
    }
    const [, node, offsetStr] = match;
    const offset = Number.parseInt(offsetStr, 10);
    if (Number.isNaN(offset)) {
        devWarn(`Invalid offset in position: ${pos}`);
        return null;
    }
    devLog(`Parsed position: ${pos} -> node=${node}, offset=${offset}`);
    positionCache.set(pos, { node, offset });
    return { node, offset };
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

function areHighlightsSuccessive(
    h1: Annotation,
    h2: Annotation,
    maxGap = 5,
): boolean {
    if (h1.pageno !== h2.pageno || h1.chapter !== h2.chapter) {
        devLog(
            `Not successive: different page (${h1.pageno} vs ${h2.pageno}) or chapter (${h1.chapter} vs ${h2.chapter})`,
        );
        return false;
    }

    const pos1 = parsePosition(h1.pos1);
    const pos2 = parsePosition(h2.pos0);
    if (!pos1 || !pos2) {
        devLog(
            `Not successive: invalid positions for h1.pos1=${h1.pos1} or h2.pos0=${h2.pos0}`,
        );
        return false;
    }

    if (pos1.node !== pos2.node) {
        devLog(
            `Not successive: different nodes (${pos1.node} vs ${pos2.node})`,
        );
        return false;
    }

    const gap = pos2.offset - pos1.offset;
    const isSuccessive = gap >= -50 && gap <= maxGap;
    devLog(
        `Checking successive: h1.pos1.offset=${pos1.offset}, h2.pos0.offset=${pos2.offset}, gap=${gap}, isSuccessive=${isSuccessive}`,
    );
    return isSuccessive;
}

export function compareAnnotations(a: Annotation, b: Annotation): number {
    // 1. Compare by pageno first
    if (a.pageno !== b.pageno) {
        return a.pageno - b.pageno;
    }
    // 2. If page numbers are equal, compare by chapter
    if (a.chapter !== b.chapter) {
        return (a.chapter ?? "").localeCompare(b.chapter ?? "");
    }
    // 3. If chapters are equal, compare by position (pos0) if available
    const aPos = a.pos0 ? parseCfi(a.pos0) : null;
    const bPos = b.pos0 ? parseCfi(b.pos0) : null;
    if (aPos?.fullPath && bPos?.fullPath) {
        if (aPos.fullPath !== bPos.fullPath) {
            return aPos.fullPath.localeCompare(bPos.fullPath);
        }
        if (aPos.offset !== bPos.offset) {
            return aPos.offset - bPos.offset;
        }
    } else if (aPos?.fullPath) {
        return -1;
    } else if (bPos?.fullPath) {
        return 1;
    }
    // 4. As a final tiebreaker, compare by datetime
    return new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
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

function formatHighlightGroup(group: Annotation[]): string {
    if (!group.length) return "";

    // Deduplicate overlaps
    const deduplicatedGroup = deduplicateOverlaps(group);

    // Use earliest datetime, shared page, and consistent chapter
    const earliestDate = deduplicatedGroup.reduce((min, h) => {
        const d = new Date(h.datetime);
        return !min || d < min ? d : min;
    }, null as Date | null);
    const pageno = deduplicatedGroup[0].pageno;
    const chapter = deduplicatedGroup.find((h) => h.chapter)?.chapter;

    // Header
    const header = chapter
        ? `### Chapter: ${chapter}\n(*Date: ${
            formatDate(
                earliestDate?.toISOString() || deduplicatedGroup[0].datetime,
            )
        } - Page: ${pageno}*)\n\n`
        : `(*Date: ${
            formatDate(
                earliestDate?.toISOString() || deduplicatedGroup[0].datetime,
            )
        } - Page: ${pageno}*)\n\n`;

    // Sort by pos0 to ensure correct text order
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
    const settings = DEFAULT_SETTINGS;
    const groups = groupAnnotationsByParagraph(
        annotations,
        settings.maxTimeGapMinutes,
    );
    devLog(`Total groups created: ${groups.length}`);
    return groups.map((group) => formatHighlightGroup(group)).join("");
}

function formatDate(dateStr: string): string {
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

function getContrastTextColor(bgColor: string, isDarkTheme: boolean): string {
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
