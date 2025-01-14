import type {
    BooleanLiteral,
    Expression,
    Identifier,
    NumericLiteral,
    StringLiteral,
    TableConstructorExpression,
    TableKey,
    TableKeyString,
    TableValue,
} from "luaparse";

export interface KoReaderHighlightImporterSettings {
    koboMountPoint: string;
    excludedFolders: string[];
    allowedFileTypes: string[];
    highlightsFolder: string;
    debugMode: boolean;
    enableFullDuplicateCheck: boolean;
}

export const DEFAULT_SETTINGS: KoReaderHighlightImporterSettings = {
    koboMountPoint: "",
    excludedFolders: [".adds", ".kobo"],
    allowedFileTypes: ["epub", "pdf", "mobi"],
    highlightsFolder: "KoReader Highlights",
    debugMode: false,
    enableFullDuplicateCheck: false,
};

export interface Annotation {
    chapter: string;
    datetime: string;
    pageno: number;
    text: string;
}

export interface DocProps {
    authors: string;
    title: string;
    description: string;
    keywords: string;
    series: string;
    language: string;
}

export interface LuaMetadata {
    docProps: DocProps;
    pages?: number | null;
    annotations: Annotation[];
}

type LuaKey = Extract<
    Expression,
    Identifier | StringLiteral | NumericLiteral | BooleanLiteral
>;
export type LuaValue = Extract<
    Expression,
    StringLiteral | NumericLiteral | BooleanLiteral | TableConstructorExpression
>;

export type Field = TableKey | TableKeyString | TableValue;

export type DuplicateChoice = "replace" | "merge" | "keep-both" | "skip";

export interface IDuplicateHandlingModal {
    openAndGetChoice(): Promise<{
        choice: DuplicateChoice;
        applyToAll: boolean;
    }>;
}
