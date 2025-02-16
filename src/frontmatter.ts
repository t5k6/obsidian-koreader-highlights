import type {
    DocProps,
    Frontmatter,
    FrontmatterSettings,
    LuaMetadata,
} from "./types";
import {
    devError,
    formatPercent,
    formatUnixTimestamp,
    secondsToHoursMinutes,
} from "./utils";

export function createFrontmatterData(
    metadata: LuaMetadata,
    settings: FrontmatterSettings,
): Frontmatter {
    const { docProps, statistics } = metadata;
    const frontmatter: Frontmatter = {
        title: docProps?.title ?? "",
        authors: docProps?.authors ?? "",
    };
    const disabled = new Set(settings?.disabledFields || []);

    // 1. Auto-include DocProps fields
    for (const [key, value] of Object.entries(docProps || {})) {
        if (!disabled.has(key) && isValidValue(value)) {
            frontmatter[key] = formatFieldValue(key, value);
        }
    }

    // 2. Add statistics if available and not disabled
    if (statistics) {
        const statMappings = {
            pages: statistics.book.pages,
            highlights: statistics.book.highlights,
            notes: statistics.book.notes,
            lastRead: statistics.book.last_open,
            totalReadTime: statistics.book.total_read_time,
            progress: statistics.derived.percentComplete,
            readingStatus: statistics.derived.readingStatus,
            averageTimePerPage: statistics.derived.averageTimePerPage,
        };

        for (const [key, value] of Object.entries(statMappings)) {
            if (!disabled.has(key) && isValidStatValue(value)) {
                frontmatter[key] = formatStatValue(key, value);
            }
        }
    }

    // Safe custom fields handling
    const customFields = Array.isArray(settings?.customFields)
        ? settings.customFields
        : [];

    for (const field of customFields) {
        try {
            const value = docProps[field as keyof DocProps];
            if (!disabled.has(field) && isValidFrontmatterValue(value)) {
                frontmatter[field] = formatFieldValue(field, value as string);
            }
        } catch (e) {
            devError(`Skipping invalid custom field ${field}:`, e);
        }
    }

    return frontmatter;
}
function isValidFrontmatterValue(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

const HTML_TAG_REGEX = /<[^>]+>/g;
const HTML_ENTITY_REGEX = /&(#39|#x27|amp|quot|lt|gt);/g;

const HTML_ENTITY_MAP: Record<string, string> = {
    "#39": "'",
    "#x27": "'",
    "amp": "&",
    "quot": '"',
    "lt": "<",
    "gt": ">",
};

function decodeHtmlEntities(str: string): string {
    return str.replace(
        HTML_ENTITY_REGEX,
        (_, entity) => HTML_ENTITY_MAP[entity] || "",
    );
}

function formatFieldValue(key: string, value: string): string {
    switch (key) {
        case "authors":
            return `[[${value}]]`;
        case "description":
            return decodeHtmlEntities(value.replace(HTML_TAG_REGEX, ""));
        default:
            return value;
    }
}

function isValidValue(value: unknown): boolean {
    return typeof value === "string" ? value.trim().length > 0 : !!value;
}

function isValidStatValue(value: unknown): boolean {
    return value !== undefined && value !== null;
}

function formatStatValue(key: string, value: unknown): string | number {
    switch (key) {
        case "lastRead":
            return formatUnixTimestamp(value as number);
        case "totalReadTime":
            return secondsToHoursMinutes(value as number);
        case "averageTimePerPage":
            return secondsToHoursMinutes((value as number) * 60);
        case "progress":
            return formatPercent(value as number);
        default:
            return value as string | number;
    }
}

/**
 * Mapping from internal field names to friendly frontmatter keys.
 */
const friendlyKeyMap: Record<string, string> = {
    title: "Title",
    authors: "Author(s)",
    pages: "Page Count",
    highlights: "Highlights",
    notes: "Notes",
    lastRead: "Last Read Date",
    totalReadTime: "Total Read Duration",
    progress: "Reading Progress",
    readingStatus: "Status",
    averageTimePerPage: "Avg. Time Per Page",
};

/**
 * Convert a camelCase string to a space-separated string (with title-case).
 */
function camelToTitle(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Returns a user-friendly key for the frontmatter.
 * Falls back to a title-cased version of the key if not explicitly mapped.
 */
function getFriendlyKey(key: string): string {
    return friendlyKeyMap[key] || camelToTitle(key);
}

export interface ParsedFrontmatter {
    [key: string]: string | string[] | number | undefined;
}

export function extractFrontmatter(content: string): ParsedFrontmatter {
    const frontmatter: ParsedFrontmatter = {};
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) return frontmatter;

    const lines = frontmatterMatch[1].split("\n");
    for (const line of lines) {
        const match = line.match(/^(\w+):\s*(.*)/);
        if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if (/^['"].*['"]$/.test(value)) {
                value = value.slice(1, -1);
            }
            if (value.startsWith("[") && value.endsWith("]")) {
                frontmatter[key] = value.slice(1, -1).split(",").map((v) =>
                    v.trim()
                );
            } else {
                frontmatter[key] = value;
            }
        }
    }
    return frontmatter;
}

export interface FrontmatterContent {
    content: string;
    frontmatter: ParsedFrontmatter;
}

export function parseFrontmatterAndContent(
    content: string,
): FrontmatterContent {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n\n/);
    if (!frontmatterMatch) {
        return { content, frontmatter: {} };
    }
    const frontmatterString = frontmatterMatch[1];
    const frontmatter = extractFrontmatter(`---\n${frontmatterString}\n---`);
    return { content: content.slice(frontmatterMatch[0].length), frontmatter };
}

/**
 * Format the frontmatter YAML. Uses friendly key names.
 */
export function formatFrontmatter(
    data: Frontmatter | ParsedFrontmatter,
    options: {
        useFriendlyKeys: boolean;
        sortKeys: boolean;
        escapeStrings: boolean;
    } = {
        useFriendlyKeys: true,
        sortKeys: true,
        escapeStrings: true,
    },
): string {
    const yamlLines: string[] = ["---"];
    const entries = options.sortKeys
        ? Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
        : Object.entries(data);

    for (const [key, value] of entries) {
        const formattedKey = options.useFriendlyKeys
            ? getFriendlyKey(key)
            : key;

        const safeKey = /[\s:]/.test(formattedKey)
            ? `"${formattedKey}"`
            : formattedKey;

        if (Array.isArray(value)) {
            const items = options.escapeStrings
                ? value.map((v) => `"${escapeYAMLString(String(v))}"`)
                : value.map(String);
            yamlLines.push(`${safeKey}: [${items.join(", ")}]`);
        } else if (typeof value === "string") {
            const escaped = options.escapeStrings
                ? `"${escapeYAMLString(value)}"`
                : (value.includes(":") || value.includes("\n"))
                ? `"${value.replace(/"/g, '\\"')}"`
                : value;
            yamlLines.push(`${safeKey}: ${escaped}`);
        } else {
            yamlLines.push(`${safeKey}: ${value}`);
        }
    }

    yamlLines.push("---\n");
    return yamlLines.join("\n");
}
function escapeYAMLString(str: string): string {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
