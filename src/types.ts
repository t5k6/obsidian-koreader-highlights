import type {
    BooleanLiteral,
    Expression,
    Identifier,
    NumericLiteral,
    StringLiteral,
    TableConstructorExpression,
} from "luaparse";

// Common base types
type BaseLuaExpression = Extract<
    Expression,
    StringLiteral | NumericLiteral | BooleanLiteral
>;

type LuaKey = Extract<
    Expression,
    Identifier | BaseLuaExpression
>;

export type LuaValue = Extract<
    Expression,
    BaseLuaExpression | TableConstructorExpression
>;

export interface BaseMetadata {
    title: string;
    authors: string;
    description?: string;
    keywords?: string;
    series?: string;
    language?: string;
}

export interface DocProps extends BaseMetadata {}

export interface ReadingProgress {
    percentComplete: number;
    averageTimePerPage: number;
    firstReadDate: Date | null;
    lastReadDate: Date;
    readingStatus: ReadingStatus;
}

export type ReadingStatus = "ongoing" | "completed" | "unstarted";

export interface ReadingStats {
    notes: number;
    highlights: number;
    pages: number;
    total_read_time: number;
    total_read_pages: number;
}

export interface BookStatistics extends BaseMetadata, ReadingStats {
    id: number;
    last_open: number;
    md5: string;
}

// Session tracking
export interface PageStatData {
    id_book: number;
    page: number;
    start_time: number;
    duration: number;
    total_pages: number;
}

export interface Annotation {
    chapter?: string;
    datetime: string;
    datetime_updated?: string;
    pageno: number;
    pageref?: string;
    text?: string;
    note?: string;
    color?: string;
    drawer?: "lighten" | "underscore" | "strikeout" | "invert"; // KOReader drawer styles
    pos0?: string;
    pos1?: string;
}

// Metadata structure
export interface LuaMetadata {
    docProps: DocProps;
    pages?: number | null;
    annotations: Annotation[];
    statistics?: {
        book: BookStatistics;
        readingSessions: PageStatData[];
        derived: ReadingProgress;
    };
    frontmatter?: Frontmatter;
}

// Frontmatter handling
export interface FrontmatterBase extends BaseMetadata {
    pages?: number;
    highlights?: number;
    notes?: number;
    progress?: string;
    readingStatus?: ReadingStatus;
}

export interface FrontmatterTiming {
    totalReadTime?: string;
    totalReadPages?: number;
    lastRead?: string;
    averageTimePerPage?: string;
    firstRead?: string;
}

export interface Frontmatter extends FrontmatterBase, FrontmatterTiming {
    [key: string]: string | string[] | number | undefined;
}

// Settings interfaces
export interface FrontmatterSettings {
    disabledFields: string[];
    customFields: string[];
}

export interface KoReaderHighlightImporterSettings {
    koboMountPoint: string;
    excludedFolders: string[];
    allowedFileTypes: string[];
    highlightsFolder: string;
    debugMode: boolean;
    enableFullDuplicateCheck: boolean;
    frontmatter: FrontmatterSettings;
    debugLevel: number;
    maxHighlightGap: number; // Max character gap for successive highlights (default: 5)
    maxTimeGapMinutes: number; // Max time gap for grouping by session (default: 10)
    mergeOverlappingHighlights: boolean; // Enable/disable overlap merging (default: true)
}

// Constants
export const DEFAULT_SETTINGS: KoReaderHighlightImporterSettings = {
    koboMountPoint: "",
    excludedFolders: [".adds", ".kobo"],
    allowedFileTypes: ["epub", "pdf", "mobi"],
    highlightsFolder: "KoReader Highlights",
    debugMode: false,
    enableFullDuplicateCheck: false,
    frontmatter: {
        disabledFields: [],
        customFields: [],
    },
    debugLevel: 0,
    maxHighlightGap: 5,
    maxTimeGapMinutes: 10,
    mergeOverlappingHighlights: true,
};

// Duplicate handling
export type DuplicateChoice = "replace" | "merge" | "keep-both" | "skip";

export interface IDuplicateHandlingModal {
    openAndGetChoice(): Promise<{
        choice: DuplicateChoice;
        applyToAll: boolean;
    }>;
}
