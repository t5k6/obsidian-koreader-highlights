export interface KoReaderHighlightImporterSettings {
    koboMountPoint: string;
    excludedFolders: string[];
    allowedFileTypes: string[];
    highlightsFolder: string;
}

export const DEFAULT_SETTINGS: KoReaderHighlightImporterSettings = {
    koboMountPoint: "",
    excludedFolders: [".adds", ".kobo"],
    allowedFileTypes: ["epub", "pdf", "mobi"],
    highlightsFolder: "KoReader Highlights",
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
}

export type LuaKey =
    | StringLiteral
    | NumericLiteral
    | BooleanLiteral
    | Identifier;

interface TableConstructorExpression {
    type: "TableConstructorExpression";
    fields: Field[];
}

export type LuaValue =
    | StringLiteral
    | NumericLiteral
    | BooleanLiteral
    | TableConstructorExpression
    | null;

export interface Field {
    type: "TableKey" | "TableValue" | "TableKeyString";
    key: LuaKey;
    value: LuaValue;
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
