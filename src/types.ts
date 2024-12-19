export interface KoReaderHighlightImporterSettings {
    koboMountPoint: string;
    excludedFolders: string[];
    allowedFileTypes: string[];
    highlightsFolder: string;
    debugMode: boolean;
}

export const DEFAULT_SETTINGS: KoReaderHighlightImporterSettings = {
    koboMountPoint: "",
    excludedFolders: [".adds", ".kobo"],
    allowedFileTypes: ["epub", "pdf", "mobi"],
    highlightsFolder: "KoReader Highlights",
    debugMode: false,
};

export interface Annotation {
    chapter: string;
    datetime: string;
    pageno: number;
    text: string;
}

export interface AnnotationTable {
    fields: TableConstructorExpression[];
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

export interface StringLiteral {
    type: "StringLiteral";
    value?: string;
    raw: string;
}

export interface NumericLiteral {
    type: "NumericLiteral";
    value?: number;
    raw: string;
}

export interface BooleanLiteral {
    type: "BooleanLiteral";
    value?: boolean;
    raw: string;
}

export interface Identifier {
    type: "Identifier";
    name: string;
    raw: string;
}

export type LuaKey =
    | { type: "StringLiteral"; value?: string; raw: string }
    | { type: "NumericLiteral"; value?: number; raw: string }
    | { type: "BooleanLiteral"; value?: boolean; raw: string }
    | { type: "Identifier"; name: string; raw: string };

interface TableConstructorExpression {
    type: "TableConstructorExpression";
    fields: Field[];
}

export type LuaValue =
    | { type: "StringLiteral"; value?: string; raw: string }
    | { type: "NumericLiteral"; value?: number; raw: string }
    | { type: "BooleanLiteral"; value?: boolean; raw: string }
    | TableConstructorExpression;

export interface Field {
    type: "TableKey" | "TableValue" | "TableKeyString";
    key: LuaKey;
    value: LuaValue;
}
