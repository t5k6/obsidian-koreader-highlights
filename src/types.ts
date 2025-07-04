import type { Expression } from "luaparse";
import type { TFile } from "obsidian";

// --- Lua Parser Related ---
export type LuaValue = Extract<
	Expression,
	string | number | boolean | Record<string, unknown> | null | undefined
>;

// --- Core Data Structures ---

export interface BaseMetadata {
	title: string;
	authors: string;
	description?: string;
	keywords?: string;
	series?: string;
	language?: string;
}

export interface DocProps extends BaseMetadata {}

export interface Annotation {
	chapter?: string;
	datetime: string;
	datetime_updated?: string;
	pageno: number;
	pageref?: string;
	text?: string;
	note?: string;
	color?: string;
	drawer?: "lighten" | "underscore" | "strikeout" | "invert";
	pos0?: string;
	pos1?: string;
}

// --- Database Related ---

export type ReadingStatus = "ongoing" | "completed" | "unstarted";

export interface ReadingProgress {
	percentComplete: number;
	averageTimePerPage: number;
	firstReadDate: Date | null;
	lastReadDate: Date;
	readingStatus: ReadingStatus;
}

// Represents data directly from the 'book' table joined with base metadata needs
export interface BookStatistics extends BaseMetadata {
	id: number;
	md5: string;
	last_open: number;
	pages: number;
	total_read_time: number;
	total_read_pages: number;
}

// Represents data directly from the 'page_stat_data' table
export interface PageStatData {
	id_book: number;
	page: number;
	start_time: number;
	duration: number;
	total_pages: number;
}

// --- Combined Metadata Structure (Input for processing) ---

export interface LuaMetadata {
	docProps: DocProps;
	pages?: number | null;
	annotations: Annotation[];
	statistics?: {
		book: BookStatistics;
		readingSessions: PageStatData[];
		derived: ReadingProgress;
	};
	originalFilePath?: string;
	md5?: string;
}

// --- Frontmatter Data Structure ---

export interface FrontmatterData {
	title: string;
	authors: string | string[];
	description?: string;
	keywords?: string | string[];
	series?: string;
	language?: string;
	pages?: number;
	highlightCount?: number;
	noteCount?: number;
	readingStatus?: ReadingStatus;
	progress?: string;
	lastRead?: string;
	firstRead?: string;
	totalReadTime?: string;
	averageTimePerPage?: string;
	[key: string]: string | string[] | number | undefined;
}

export interface ParsedFrontmatter {
	[key: string]: string | string[] | number | undefined;
}

export interface FrontmatterContent {
	content: string;
	frontmatter: ParsedFrontmatter;
}

// --- Settings Related Types ---

export interface FrontmatterSettings {
	disabledFields: string[];
	customFields: string[];
}

export interface KoreaderTemplateSettings {
	useCustomTemplate: boolean;
	source: "vault" | "external" | string;
	selectedTemplate: string;
	templateDir: string;
}

// Main Plugin Settings Interface
export interface KoreaderHighlightImporterSettings {
	koboMountPoint: string;
	excludedFolders: string[];
	allowedFileTypes: string[];
	highlightsFolder: string;
	debugMode: boolean;
	debugLevel: 0 | 1 | 2 | 3; // 0=None, 1=Info, 2=Warn, 3=Error
	enableFullDuplicateCheck: boolean;
	autoMergeOnAddition: boolean;
	frontmatter: FrontmatterSettings;
	maxHighlightGap: number;
	maxTimeGapMinutes: number;
	mergeOverlappingHighlights: boolean;
	template: KoreaderTemplateSettings;
}

// --- UI / Modal Related Types ---

export type DuplicateChoice = "replace" | "merge" | "keep-both" | "skip" | "automerge";

export interface DuplicateMatch {
	file: TFile;
	matchType: "exact" | "updated" | "divergent";
	newHighlights: number;
	modifiedHighlights: number;
	luaMetadata: LuaMetadata;
}

export interface IDuplicateHandlingModal {
	openAndGetChoice(): Promise<{
		choice: DuplicateChoice | null; // choice can be null if modal is closed
		applyToAll: boolean;
	}>;
}

export interface RenderContext {
	isFirstInChapter: boolean;
	separators?: (" " | " [...] ")[];
}

export interface TemplateData {
	[key: string]: string | boolean | number | string[] | undefined;
	highlight?: string;
	chapter?: string;
	pageno?: number;
	isFirstInChapter?: boolean;
	note?: string;
	notes?: string[];
	date?: string;
}

export interface TemplateDefinition {
	id: string;
	name: string;
	description: string;
	content: string;
}
