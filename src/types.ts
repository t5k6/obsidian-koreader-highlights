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

export interface TableConstructorExpression {
    type: string;
    fields: Field[];
}

export interface Field {
    type: string;
    key: string;
    raw: string;
    value: any;
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
