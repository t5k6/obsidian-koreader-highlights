import type { App, TFile } from "obsidian";
import type { DeviceService } from "src/services/device/DeviceService";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { Diagnostic } from "src/services/parsing/MetadataParser";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import type { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import type { LocalIndexService } from "src/services/vault/LocalIndexService";
import type { MergeHandler } from "src/services/vault/MergeHandler";
import type { NoteCreationService } from "src/services/vault/NoteCreationService";
import type { SnapshotManager } from "src/services/vault/SnapshotManager";
import type {
	DuplicateHandlingSession,
	DuplicateMatch,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
} from "src/types";

export type SkipReason = "UNCHANGED" | "NO_ANNOTATIONS" | "USER_DECISION";
export type WarningCode = "duplicate-timeout";

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
}

export type ImportPlan =
	| { kind: "SKIP"; reason: SkipReason }
	| { kind: "CREATE"; withTimeoutWarning?: boolean }
	| { kind: "MERGE"; match: DuplicateMatch; session?: DuplicateHandlingSession }
	| { kind: "AWAIT_USER_CHOICE"; title: string; existingPath: string | null };

export type ExecResult =
	| { status: "created"; file: TFile }
	| { status: "merged"; file: TFile }
	| { status: "automerged"; file: TFile }
	| { status: "skipped"; file: null };

export interface ImportIO {
	// planning + execution ports
	fs: FileSystemService;
	index: LocalIndexService;
	parser: (luaContent: string) => {
		meta: Omit<LuaMetadata, "originalFilePath" | "statistics">;
		diagnostics: Diagnostic[];
	};
	device: DeviceService;

	fmService: FrontmatterService;
	templateManager: TemplateManager;

	dupFinder: DuplicateFinder;
	mergeHandler: MergeHandler;

	fileNameGen: FileNameGenerator;
	snapshot: SnapshotManager;

	settings: KoreaderHighlightImporterSettings;
	app: App;
	log: LoggingService;

	// executor-only helper
	noteCreation: NoteCreationService;
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
	| "fmService"
	| "mergeHandler"
	| "fileNameGen"
	| "snapshot"
	| "settings"
	| "log"
	| "noteCreation"
>;
