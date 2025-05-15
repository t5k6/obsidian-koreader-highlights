import type {
    DocProps,
    FrontmatterData,
    FrontmatterSettings,
    LuaMetadata,
    ParsedFrontmatter,
} from "../types";
import {
    formatDate,
    formatPercent,
    secondsToHoursMinutes,
} from "../utils/formatUtils";
import { devLog, devWarn } from "../utils/logging";

const FRIENDLY_KEY_MAP: Record<string, string> = {
    title: "Title",
    authors: "Author(s)",
    description: "Description",
    keywords: "Keywords",
    series: "Series",
    language: "Language",
    pages: "Page Count",
    highlightCount: "Highlight Count",
    noteCount: "Note Count",
    lastRead: "Last Read Date",
    firstRead: "First Read Date",
    totalReadTime: "Total Read Duration",
    progress: "Reading Progress",
    readingStatus: "Status",
    averageTimePerPage: "Avg. Time Per Page",
};

function toTitleCase(str: string): string {
    if (!str) return "";
    const spaced = str
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ");
    return spaced
        .split(" ")
        .map((word) =>
            word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        )
        .join(" ");
}

function escapeYAMLString(str: string): string {
    if (str.includes('"') || str.includes("\\")) {
        str = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }
    // Check if quoting is necessary based on YAML spec
    const needsQuotes =
        /[:{}\[\]&*#!|>@`"']|^- |^%|^\? |^\s|\s$|^(true|false|null|on|off|yes|no)$/i
            .test(str) ||
        str.includes("\n") || str.length === 0;
    return needsQuotes ? `"${str}"` : str;
}

function getFriendlyKey(key: string): string {
    return FRIENDLY_KEY_MAP[key] || toTitleCase(key);
}

export class FrontmatterGenerator {
    constructor() {
    }

    public createFrontmatterData(
        metadata: LuaMetadata,
        settings: FrontmatterSettings,
    ): FrontmatterData {
        const { docProps, statistics, annotations } = metadata;
        // Ensure required fields have defaults, even if empty in docProps
        const frontmatter: Partial<FrontmatterData> = {
            title: docProps?.title || "",
        };

        if (
            docProps?.authors && !settings.disabledFields?.includes("authors")
        ) {
            // Now call formatDocPropValue for authors
            const formattedAuthors = this.formatDocPropValue(
                "authors",
                docProps.authors,
            );
            frontmatter.authors = formattedAuthors; // This can be string or string[]
        } else if (
            !docProps?.authors && !settings.disabledFields?.includes("authors")
        ) {
            frontmatter.authors = ""; // Default to empty string if no authors from docProps
        }

        const disabled = new Set(settings?.disabledFields || []);
        const customFields = settings?.customFields || [];

        devLog(
            `Generating frontmatter for: ${docProps?.title}. Disabled fields: ${
                [...disabled].join(", ")
            }, Custom fields: ${customFields.join(", ")}`,
        );

        // 1. Add DocProps fields (excluding title/authors)
        if (docProps) {
            for (const key in docProps) {
                const typedKey = key as keyof DocProps;

                if (
                    typedKey !== "title" && typedKey !== "authors" &&
                    (frontmatter as any)[typedKey] === undefined
                ) {
                    if (
                        Object.prototype.hasOwnProperty.call(docProps, typedKey)
                    ) {
                        const value = docProps[typedKey];
                        if (
                            !disabled.has(typedKey) && this.isValidValue(value)
                        ) {
                            (frontmatter as any)[typedKey] = this
                                .formatDocPropValue(typedKey, value as string);
                        }
                    }
                }
            }
        }

        // --- 2. Calculate Highlight/Note Counts ---
        const highlightCount = annotations?.length ?? 0;
        const noteCount =
            annotations?.filter((a) => a.note && a.note.trim().length > 0)
                .length ?? 0;

        if (!disabled.has("highlightCount") && highlightCount > 0) {
            frontmatter.highlightCount = highlightCount;
        }
        if (!disabled.has("noteCount") && noteCount > 0) {
            frontmatter.noteCount = noteCount;
        }

        // --- 3. Add statistics fields ---
        if (statistics?.derived && statistics.book) {
            const statsAvailable = {
                pages: statistics.book.pages,
                lastRead: statistics.derived.lastReadDate,
                totalReadTime: statistics.book.total_read_time,
                progress: statistics.derived.percentComplete,
                readingStatus: statistics.derived.readingStatus,
                averageTimePerPage: statistics.derived.averageTimePerPage,
                firstRead: statistics.derived.firstReadDate,
            };

            for (const key in statsAvailable) {
                const typedKey = key as keyof typeof statsAvailable;
                if (
                    Object.prototype.hasOwnProperty.call(
                        statsAvailable,
                        typedKey,
                    )
                ) {
                    const value = statsAvailable[typedKey];
                    // Special check for 'pages' to avoid adding it twice if it was in docProps
                    if (
                        typedKey === "pages" &&
                        frontmatter.pages !== undefined &&
                        !customFields.includes("pages")
                    ) continue;

                    if (
                        !disabled.has(typedKey) && this.isValidStatValue(value)
                    ) {
                        frontmatter[typedKey] = this.formatStatValue(
                            typedKey,
                            value,
                        ) as any; // Use 'as any'
                    }
                }
            }
        } else {
            devLog("No full statistics data available for frontmatter.");
        }

        // 4. Add explicitly requested custom fields (if they exist in docProps and are valid)
        if (docProps) {
            for (const field of customFields) {
                if (
                    !disabled.has(field) &&
                    Object.prototype.hasOwnProperty.call(docProps, field) &&
                    (frontmatter as any)[field] === undefined
                ) {
                    const value = docProps[field as keyof DocProps];
                    if (this.isValidValue(value)) {
                        (frontmatter as any)[field] = this.formatDocPropValue(
                            field,
                            value as string,
                        );
                    }
                }
            }
        }
        return frontmatter as FrontmatterData;
    }

    private isValidValue(value: unknown): boolean {
        if (value === null || value === undefined) return false;
        if (typeof value === "string") return value.trim().length > 0;
        return true; // Allow numbers, booleans etc.
    }

    private isValidStatValue(value: unknown): boolean {
        return value !== undefined && value !== null;
    }

    private formatDocPropValue(key: string, value: string): string | string[] {
        // Ensure value is a string before processing, or handle other types if necessary
        const strValue = String(value);

        switch (key) {
            case "authors":
                const authorsList = strValue
                    .split(/\s*[,;\n]\s*|\s*\n\s*/) // Split by comma, semicolon, or newline
                    .map((a) => a.trim())
                    .filter(Boolean);

                if (authorsList.length === 0) {
                    return ""; // No valid authors found
                }
                // Format as Obsidian links
                const linkedAuthors = authorsList.map((author) =>
                    `[[${author}]]`
                );

                // Return single string for one author, array for multiple for proper YAML list
                return linkedAuthors.length === 1
                    ? linkedAuthors[0]
                    : linkedAuthors;
            case "description":
                // Basic HTML tag removal
                return this.decodeHtmlEntities(
                    strValue.replace(/<[^>]+>/g, ""),
                );
            case "keywords":
                return strValue.split(",").map((k) => k.trim()).filter(Boolean);
            default:
                return strValue.trim();
        }
    }

    private formatStatValue(key: string, value: unknown): string | number {
        switch (key) {
            case "lastRead":
            case "firstRead":
                return value instanceof Date
                    ? formatDate(value.toISOString())
                    : (typeof value === "string" && value
                        ? formatDate(value)
                        : "");
            case "totalReadTime":
                return secondsToHoursMinutes(value as number);
            case "averageTimePerPage":
                return secondsToHoursMinutes((value as number) * 60); // value is in minutes
            case "progress":
                return formatPercent(value as number);
            case "pages":
            case "highlightCount":
            case "noteCount":
                return typeof value === "number" ? value : 0;
            case "readingStatus":
                return String(value ?? "");
            default:
                return String(value ?? "");
        }
    }

    private decodeHtmlEntities(str: string): string {
        const entities: Record<string, string> = {
            "&": "&",
            "<": "<",
            ">": ">",
        };
        return str.replace(/&[#\w]+;/g, (match) => entities[match] || match);
    }

    public generateYamlFromLuaMetadata(
        metadata: LuaMetadata,
        settings: FrontmatterSettings,
    ): string {
        const data = this.createFrontmatterData(metadata, settings);
        return this.formatDataToYaml(data, {
            useFriendlyKeys: true,
            sortKeys: true,
        });
    }

    public formatDataToYaml(
        data: FrontmatterData | ParsedFrontmatter,
        options: {
            useFriendlyKeys?: boolean;
            sortKeys?: boolean;
        } = {},
    ): string {
        const { useFriendlyKeys = true, sortKeys = true } = options;
        const yamlLines: string[] = [];

        let entries = Object.entries(data);
        if (sortKeys) {
            entries = entries.sort(([aKey], [bKey]) =>
                aKey.localeCompare(bKey)
            );
        }

        for (const [key, value] of entries) {
            if (value === undefined || value === null) continue;

            const formattedKey = useFriendlyKeys ? getFriendlyKey(key) : key;
            // Keys with special characters or spaces need quoting in YAML
            const safeKey = /[:\s-]|^[0-9]/.test(formattedKey)
                ? `"${formattedKey}"`
                : formattedKey;

            let formattedValue: string;
            if (Array.isArray(value)) {
                const items = value.map((item) =>
                    escapeYAMLString(String(item))
                ).join(", ");
                formattedValue = `[${items}]`;
            } else if (typeof value === "object" && value !== null) {
                try {
                    formattedValue = escapeYAMLString(JSON.stringify(value));
                } catch {
                    devWarn(
                        `Skipping complex object in frontmatter key "${key}" during YAML formatting.`,
                    );
                    continue;
                }
            } else {
                formattedValue = escapeYAMLString(String(value));
            }
            yamlLines.push(`${safeKey}: ${formattedValue}`);
        }

        if (yamlLines.length === 0) {
            return "";
        }
        return `---\n${yamlLines.join("\n")}\n---`;
    }
}
