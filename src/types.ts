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

export interface PositionObject {
	x: number;
	y: number;
}

export const DRAWER_TYPES = [
	"lighten",
	"underscore",
	"strikeout",
	"invert",
] as const;
export type DrawerType = (typeof DRAWER_TYPES)[number];

export interface Annotation {
	id?: string;
	chapter?: string;
	datetime: string;
	datetime_updated?: string;
	pageno: number;
	pageref?: string;
	text?: string;
	note?: string;
	color?: string;
	drawer?: DrawerType;
	pos0?: string | PositionObject;
	pos1?: string | PositionObject;
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
	useUnknownAuthor: boolean;
}

export interface KoreaderTemplateSettings {
	useCustomTemplate: boolean;
	source: "vault" | "external" | string;
	selectedTemplate: string;
	templateDir: string;
}

// Main Plugin Settings Interface
export interface KoreaderHighlightImporterSettings {
	koreaderMountPoint: string;
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

export type DuplicateChoice =
	| "replace"
	| "merge"
	| "keep-both"
	| "skip"
	| "automerge";

export interface DuplicateMatch {
	file: TFile;
	matchType: "exact" | "updated" | "divergent";
	newHighlights: number;
	modifiedHighlights: number;
	luaMetadata: LuaMetadata;
	canMergeSafely: boolean;
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
	date?: string; // Stable "en-US" format
	localeDate?: string; // system locale format
	dailyNoteLink?: string; // daily note link format
}

export interface TemplateDefinition {
	id: string;
	name: string;
	description: string;
	content: string;
}

export interface Summary {
	created: number;
	merged: number;
	automerged: number;
	skipped: number;
	errors: number;
}

export const blankSummary = (): Summary => ({
	created: 0,
	merged: 0,
	automerged: 0,
	skipped: 0,
	errors: 0,
});

export const addSummary = (a: Summary, b: Summary): Summary => ({
	created: a.created + b.created,
	merged: a.merged + b.merged,
	automerged: a.automerged + b.automerged,
	skipped: a.skipped + b.skipped,
	errors: a.errors + b.errors,
});

/**
 * A generic interface for a key-value cache.
 * Both the built-in `Map` and our custom `LruCache` conform to this structure.
 */
export interface Cache<K, V> {
	get(key: K): V | undefined;
	set(key: K, value: V): void;
	delete(key: K): boolean;
	clear(): void;
	readonly size: number;
}

/**
 * A function signature for an asynchronous data loader, used with memoization.
 */
export type AsyncLoader<K, V> = (key: K) => Promise<V>;
