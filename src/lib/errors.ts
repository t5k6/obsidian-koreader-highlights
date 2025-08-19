import type { Result } from "src/lib/core/result";

// Structured error objects for expected failures handled via Result<T, E>

export type FileSystemFailure =
	| { kind: "NotFound"; path: string }
	| { kind: "PermissionDenied"; path: string }
	| { kind: "NotADirectory"; path: string }
	| { kind: "IsADirectory"; path: string }
	| { kind: "WriteFailed"; path: string; cause: unknown }
	| { kind: "ReadFailed"; path: string; cause: unknown };

export type ParseFailure =
	| { kind: "LuaParseError"; message: string; line?: number }
	| { kind: "YamlParseError"; message: string }
	| { kind: "TemplateParseError"; message: string }
	| { kind: "DateParseError"; input: string }
	| CfiParseError;

// Specific parse error for EPUB CFI strings
export type CfiParseError = { kind: "CFI_PARSE_FAILED"; cfi: string };

export type MergeFailure =
	| { kind: "SnapshotMissing"; uid: string }
	| { kind: "BackupFailed"; path: string; cause: unknown }
	| { kind: "UidMissing"; path: string };

// Database failures for sql.js and persistence lifecycle
export type DatabaseFailure =
	| { kind: "DbOpenFailed"; path: string; cause: unknown }
	| { kind: "DbValidateFailed"; path: string; cause: unknown }
	| { kind: "DbPersistFailed"; path: string; cause: unknown };

export type CapabilityFailure = {
	kind: "CAPABILITY_DENIED";
	capability: string;
	message?: string;
};

// Domain-specific failures
export type MetadataFailure = { kind: "MetadataContentMissing"; path: string };

// Configuration failures for user settings and required fields
export type ConfigFailure =
	| { kind: "ConfigMissing"; field: string }
	| { kind: "ConfigInvalid"; field: string; reason?: string };

// Snapshot errors now live at lib level to avoid domain coupling
export type SnapshotError =
	| { kind: "CAPABILITY_UNAVAILABLE"; message: string }
	| { kind: "TARGET_FILE_MISSING"; message: string }
	| { kind: "SNAPSHOT_MISSING"; message: string }
	| { kind: "WRITE_FORBIDDEN"; message: string; cause?: unknown }
	| { kind: "READ_FORBIDDEN"; message: string; cause?: unknown }
	| { kind: "WRITE_FAILED"; message: string; cause?: unknown }
	| { kind: "READ_FAILED"; message: string; cause?: unknown }
	| { kind: "UID_MISSING"; message: string }
	| { kind: "UID_MISMATCH"; message: string }
	| { kind: "MIGRATION_FAILED"; message: string; cause?: unknown };

export type TemplateNotFound = { kind: "TemplateNotFound"; path: string };
export type TemplateInvalid = {
	kind: "TemplateInvalid";
	id: string;
	errors: string[];
};
export type TemplateFailure = TemplateNotFound | TemplateInvalid;

// Union of all expected failures
export type AppFailure =
	| FileSystemFailure
	| ParseFailure
	| MergeFailure
	| DatabaseFailure
	| CapabilityFailure
	| MetadataFailure
	| ConfigFailure
	| SnapshotError
	| TemplateFailure;

// Preferred Result alias for structured, expected failures across the app
export type AppResult<T> = Result<T, AppFailure>;

/** Base class for all unexpected plugin errors. */
export class PluginError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = new.target.name;
	}
}

/** Thrown when a critical service fails to initialize. */
export class InitializationError extends PluginError {}

// A generic shape for errors that provide their own message.
export type DescriptiveError = {
	message: string;
	cause?: unknown;
};

/** Type guard for structured AppFailure. */
export function isAppFailure(e: unknown): e is AppFailure {
	return (
		typeof e === "object" &&
		e !== null &&
		"kind" in (e as any) &&
		typeof (e as any).kind === "string"
	);
}

/** Maps a structured AppFailure to a user-friendly message. */
export function formatAppFailure(err: AppFailure): string {
	switch (err.kind) {
		case "NotFound":
			return `File not found: ${err.path}`;
		case "PermissionDenied":
			return `Permission denied: ${err.path}`;
		case "NotADirectory":
			return `Not a directory: ${err.path}`;
		case "IsADirectory":
			return `Expected a file but found a directory: ${err.path}`;
		case "WriteFailed":
			return `Write failed at ${err.path}`;
		case "ReadFailed":
			return `Read failed at ${err.path}`;
		case "LuaParseError":
			return err.line != null
				? `Lua parse error on line ${err.line}: ${err.message}`
				: `Lua parse error: ${err.message}`;
		case "YamlParseError":
			return `YAML parse error: ${err.message}`;
		case "TemplateParseError":
			return `Template parse error: ${err.message}`;
		case "DateParseError":
			return `Invalid date input: ${err.input}`;
		case "CFI_PARSE_FAILED":
			return `Invalid CFI string: ${err.cfi}`;
		case "SnapshotMissing":
			return `Snapshot missing for UID ${err.uid}`;
		case "BackupFailed":
			return `Backup failed for ${err.path}`;
		case "UidMissing":
			return `UID is missing in ${err.path}`;
		case "DbOpenFailed":
			return `Failed to open database at ${err.path}`;
		case "DbValidateFailed":
			return `Failed to validate database at ${err.path}`;
		case "DbPersistFailed":
			return `Failed to persist database at ${err.path}`;
		case "CAPABILITY_DENIED":
			return err.message ?? `Capability denied: ${err.capability}`;
		case "MetadataContentMissing":
			return `Metadata content missing in ${err.path}`;
		case "ConfigMissing":
			return `Missing required setting: ${err.field}`;
		case "ConfigInvalid":
			return `Invalid setting ${err.field}${err.reason ? `: ${err.reason}` : ""}`;
		case "CAPABILITY_UNAVAILABLE":
		case "TARGET_FILE_MISSING":
		case "SNAPSHOT_MISSING":
		case "WRITE_FORBIDDEN":
		case "READ_FORBIDDEN":
		case "WRITE_FAILED":
		case "READ_FAILED":
		case "UID_MISSING":
		case "UID_MISMATCH":
		case "MIGRATION_FAILED":
			return err.message;
		case "TemplateNotFound":
			return `Template not found: ${err.path}`;
		case "TemplateInvalid": {
			const errorDetails = err.errors.join(", ");
			return `Template "${err.id}" is invalid: ${errorDetails}`;
		}
		default: {
			const _exhaustive: never = err;
			return "Operation failed";
		}
	}
}

/** Unified formatter for any error-ish value. This should be the primary entry point for displaying errors in the UI. */
export function formatError(error: unknown): string {
	if (isAppFailure(error)) {
		return formatAppFailure(error);
	}
	if (error instanceof PluginError || error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return `An unexpected error occurred: ${JSON.stringify(error)}`;
	} catch {
		return "An unexpected and un-serializable error occurred.";
	}
}
