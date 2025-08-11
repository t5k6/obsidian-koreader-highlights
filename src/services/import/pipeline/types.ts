import type { TFile } from "obsidian";
import type { LuaMetadata } from "src/types";

export type SkipReason = "UNCHANGED" | "NO_ANNOTATIONS" | "USER_DECISION";
export type WarningCode = "duplicate-timeout";

// Port for all user-facing decisions required by the import pipeline.
// Removed UserInteractionService interface

export interface ImportContext {
	// inputs
	metadataPath: string;
	sdrPath: string;
	forceNote?: TFile | null;
	session: import("src/types").DuplicateHandlingSession;
	forceReimport?: boolean;

	// evolving state
	stats: { mtimeMs: number; size: number } | null;
	latestTs: string | null;
	luaMetadata: LuaMetadata | null;
	warnings: WarningCode[]; // e.g., ['duplicate-timeout']
}

export type ImportPlan =
	| { kind: "SKIP"; reason: SkipReason }
	| { kind: "CREATE"; withTimeoutWarning?: boolean }
	| {
			kind: "MERGE";
			match: import("src/types").DuplicateMatch;
			session: import("src/types").DuplicateHandlingSession;
	  };

export type StepOutcome =
	| { type: "continue"; ctx: ImportContext }
	| { type: "plan"; ctx: ImportContext; plan: ImportPlan };

export type ExecResult =
	| { status: "created"; file: TFile }
	| { status: "merged"; file: TFile }
	| { status: "automerged"; file: TFile }
	| { status: "skipped"; file: null };

export interface ImportIO {
	// surface all services the steps need; easy to mock in tests
	fs: import("src/services/FileSystemService").FileSystemService;
	index: import("src/services/vault/LocalIndexService").LocalIndexService;
	parser: import("src/services/parsing/MetadataParser").MetadataParser;
	statsSvc: import("src/services/device/DeviceStatisticsService").DeviceStatisticsService;
	fmService: import("src/services/parsing/FrontmatterService").FrontmatterService;
	fmGen: import("src/services/parsing/FrontmatterGenerator").FrontmatterGenerator;
	contentGen: import("src/services/vault/ContentGenerator").ContentGenerator;
	dupFinder: import("src/services/vault/DuplicateFinder").DuplicateFinder;
	dupHandler: import("src/services/vault/DuplicateHandler").DuplicateHandler;
	fileNameGen: import("src/services/vault/FileNameGenerator").FileNameGenerator;
	snapshot: import("src/services/vault/SnapshotManager").SnapshotManager;
	settings: import("src/types").KoreaderHighlightImporterSettings;
	app: import("obsidian").App;
	log: import("src/services/LoggingService").LoggingService;
	// UI port for user interactions
	ui: import("src/services/ui/PromptService").PromptService;
}
