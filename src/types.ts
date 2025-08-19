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
	lastReadDate: Date | null;
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

// Comment style for tracking imported highlights
export type CommentStyle = "html" | "md" | "none";

// Main Plugin Settings Interface
export interface KoreaderHighlightImporterSettings {
	koreaderScanPath: string;
	/** Optional absolute path override to KOReader statistics.sqlite3 file. Empty string disables override. */
	statsDbPathOverride: string;
	excludedFolders: string[];
	allowedFileTypes: string[];
	highlightsFolder: string;
	logToFile: boolean;
	logLevel: 0 | 1 | 2 | 3; // 0=None, 1=Info, 2=Warn, 3=Error
	logsFolder: string;
	enableFullDuplicateCheck: boolean;
	fileNameTemplate: string;
	useCustomFileNameTemplate: boolean;
	autoMergeOnAddition: boolean;
	frontmatter: FrontmatterSettings;
	maxHighlightGap: number;
	maxTimeGapMinutes: number;
	mergeOverlappingHighlights: boolean;
	template: KoreaderTemplateSettings;
	commentStyle: CommentStyle;
	backupRetentionDays: number;
	lastDeviceTimestamp?: string;
	scanTimeoutSeconds: number;
}

/** Import Indexing **/

export interface ImportIndexEntry {
	/** The file's modification time (in epoch milliseconds) when it was last processed. */
	mtime: number;
	/** The file's size (in bytes) when it was last processed. */
	size: number;
	/** The ISO datetime string of the newest annotation found in the entire file. */
	newestAnnotationTimestamp: string | null;
}

export type ImportIndex = Record<string, ImportIndexEntry>;

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
	/** UID currently assigned to the existing file (from cache), if present. */
	expectedUid?: string;
	canMergeSafely: boolean;
}

// Duplicate scan confidence and standardized result used by the pipeline
export type ScanConfidence = "full" | "partial";

export interface DuplicateScanResult {
	confidence: ScanConfidence;
	match: DuplicateMatch | null;
}

export interface DuplicateHandlingSession {
	applyToAll: boolean;
	choice: DuplicateChoice | null;
}

export type StaleLocationChoice = "merge-stale" | "skip-stale";

export interface StaleLocationSession {
	applyToAll: boolean;
	choice: StaleLocationChoice | null;
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

/**
 * TemplateData is a readonly, strictly keyed shape for template rendering.
 * Keys are derived to enable keyof-based validation elsewhere.
 */
export interface TemplateData {
	readonly highlight?: string;
	readonly highlightPlain?: string;
	readonly chapter?: string;
	readonly pageno?: number;
	readonly isFirstInChapter?: boolean;
	readonly note?: string;
	readonly notes?: readonly string[];
	readonly date?: string; // Stable "en-US" format
	readonly localeDate?: string; // system locale format
	readonly dailyNoteLink?: string; // daily note link format

	// Color-related variables derived from KOReader metadata
	readonly color?: string; // normalized palette color (red, orange, yellow, green, olive, cyan, blue, purple, gray)
	readonly drawer?: DrawerType; // KOReader drawer style
	readonly khlBg?: string; // e.g., "var(--khl-yellow)"
	readonly khlFg?: string; // e.g., "var(--on-khl-yellow)"
	readonly callout?: string; // alias for color for templates preferring {{callout}}
}
/**
 * Narrow set of allowed keys for variables/blocks in templates.
 * Keep in sync with TemplateData keys.
 */
export type TemplateDataKey = keyof TemplateData;
/**
 * Readonly variant consumers should accept.
 */
export type ReadonlyTemplateData = Readonly<TemplateData>;

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
 * Implementations include the built-in `Map` and our consolidated `SimpleCache` (LRU-capable).
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

export interface Disposable {
	dispose(): void | Promise<void>;
}

export interface SettingsObserver {
	onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
		oldSettings?: KoreaderHighlightImporterSettings,
	): void;
}

export interface DebouncedFn {
	(): void;
	cancel(): void;
}

/** Book metadata extracted from a vault file for indexing */
export interface BookMetadata {
	key: string;
	title: string;
	authors: string;
	vaultPath: string;
}

/** Interface for metadata extractor used by indexing pipeline */
export interface FileMetadataExtractor {
	extractMetadata(file: TFile): Promise<BookMetadata | null>;
}

// --- File Operation Result Types ---

export type FileOperationResult =
	| { success: true; file: TFile }
	| {
			success: false;
			reason: "user_skipped" | "collision" | "error";
			error?: Error;
	  };

// --- Persisted Plugin Data Shape ---

export interface PluginData {
	/** Increment when the shape of `settings` changes. */
	schemaVersion: number;
	/** User settings (validated/canonicalized). */
	settings: KoreaderHighlightImporterSettings;
	/** Ledger of idempotent migrations applied. */
	appliedMigrations: string[];
	/** Last plugin version that successfully ran migrations (diagnostics). */
	lastPluginMigratedTo?: string;
}

export const CURRENT_SCHEMA_VERSION = 1;
