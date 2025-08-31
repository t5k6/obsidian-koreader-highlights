import type { App, TFile } from "obsidian";
import type { Result } from "src/lib/core/result";
import type { ParseFailure } from "src/lib/errors/types";
import type { Diagnostic } from "src/lib/parsing/luaParser";
import type { DeviceService } from "src/services/device/DeviceService";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import type { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import type { MergeHandler } from "src/services/vault/MergeHandler";
import type { NotePersistenceService } from "src/services/vault/NotePersistenceService";
import type {
	DuplicateHandlingSession,
	DuplicateMatch,
	DuplicateScanResult,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
} from "src/types";
import type { NoteEditorService } from "../parsing/NoteEditorService";

export type SkipReason = "UNCHANGED" | "NO_ANNOTATIONS" | "USER_DECISION";
export type WarningCode =
	| "duplicate-timeout"
	| "FILENAME_TRUNCATED"
	| "BACKUP_FAILED"
	| "SNAPSHOT_FAILED"
	| "UID_ASSIGN_FAILED";

export interface ImportWarning {
	code: WarningCode;
	message: string;
}

export interface ImportContext {
	metadataPath: string;
	sdrPath: string;
	forceNote?: TFile | null;
	forceReimport?: boolean;
	stats: { mtimeMs: number; size: number } | null;
	latestTs: string | null;
	luaMetadata: LuaMetadata | null;
	warnings: WarningCode[];
	session?: DuplicateHandlingSession;
	match?: DuplicateMatch | null;
	confidence?: DuplicateScanResult["confidence"];
	indexCleanupPaths?: string[];
}

export type ImportPlan =
	| { kind: "SKIP"; reason: SkipReason }
	| { kind: "CREATE"; withTimeoutWarning?: boolean }
	| { kind: "MERGE"; match: DuplicateMatch; session?: DuplicateHandlingSession }
	| { kind: "AWAIT_USER_CHOICE"; title: string; existingPath: string | null }
	| { kind: "AWAIT_STALE_LOCATION_CONFIRM"; match: DuplicateMatch };

export type ExecResult =
	| { status: "created"; file: TFile; warnings: ImportWarning[] }
	| { status: "merged"; file: TFile; warnings: ImportWarning[] }
	| { status: "automerged"; file: TFile; warnings: ImportWarning[] }
	| { status: "skipped"; file: null; warnings: ImportWarning[] };

export interface ImportIO {
	// planning + execution ports
	fs: FileSystemService;
	index: IndexCoordinator;
	parser: (luaContent: string) => Result<
		{
			meta: Omit<LuaMetadata, "originalFilePath" | "statistics">;
			diagnostics: Diagnostic[];
		},
		ParseFailure
	>;
	device: DeviceService;

	noteEditorService: NoteEditorService;
	templateManager: TemplateManager;
	persistence: NotePersistenceService;

	dupFinder: DuplicateFinder;
	mergeHandler: MergeHandler;

	settings: KoreaderHighlightImporterSettings;
	app: App;
	log: LoggingService;
}

export type PlannerIO = Pick<
	ImportIO,
	| "fs"
	| "index"
	| "parser"
	| "device"
	| "dupFinder"
	| "log"
	| "settings"
	| "app"
>;

export type ExecutorIO = Pick<
	ImportIO,
	| "app"
	| "fs"
	| "templateManager"
	| "mergeHandler"
	| "persistence"
	| "settings"
	| "log"
>;

export type PreFlightIO = Pick<ImportIO, "device">;
