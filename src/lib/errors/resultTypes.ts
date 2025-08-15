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
	| { kind: "TemplateParseError"; message: string };

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
	kind: "CapabilityUnavailable";
	capability: string;
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

// Union of all expected failures
export type AppFailure =
	| FileSystemFailure
	| ParseFailure
	| MergeFailure
	| DatabaseFailure
	| CapabilityFailure
	| MetadataFailure
	| ConfigFailure
	| SnapshotError;
