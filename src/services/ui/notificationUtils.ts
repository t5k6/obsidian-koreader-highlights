import { Notice } from "obsidian";
import { isErr, type Result } from "src/lib/core/result";
import type {
	AppFailure,
	AppResult,
	FileSystemFailure,
} from "src/lib/errors/types";
import { formatAppFailure } from "src/lib/errors/types";

/**
 * Shell-level helper: awaits an AppResult-returning promise and shows a Notice on Err.
 * Keeps core services free of UI concerns.
 */
// Overloads to support both AppResult and generic Result-based call sites
export async function notifyOnError<T>(
	operation: Promise<AppResult<T>>,
	ops?: { message?: string | ((err: any) => string); timeout?: number },
): Promise<AppResult<T>>;
export async function notifyOnError<T, E>(
	operation: Promise<Result<T, E>>,
	ops?: { message?: string | ((err: any) => string); timeout?: number },
): Promise<Result<T, E>>;

export async function notifyOnError<T, E = AppFailure>(
	operation: Promise<Result<T, E>>,
	ops?: { message?: string | ((err: any) => string); timeout?: number },
): Promise<Result<T, E>> {
	const res = await operation;
	if (isErr(res)) {
		const msg = ops?.message
			? typeof ops.message === "function"
				? ops.message(res.error as any)
				: ops.message
			: hasKind(res.error)
				? formatAppFailure(res.error as unknown as AppFailure)
				: formatFallback(res.error);
		new Notice(msg, ops?.timeout ?? 7000);
	}
	return res;
}

function hasKind(x: unknown): x is { kind: string } {
	return !!x && typeof x === "object" && "kind" in (x as any);
}

function formatFallback(err: unknown): string {
	if (typeof err === "string") return err;
	if (err instanceof Error) return err.message;
	try {
		return JSON.stringify(err);
	} catch {
		return "Operation failed";
	}
}

/**
 * A specific overload to handle filesystem failures with consistent messaging.
 */
export async function notifyOnFsError<T>(
	operation: Promise<AppResult<T>>,
	ops?: {
		message?: string | ((err: any) => string);
		timeout?: number;
		onceKey?: string;
	},
): Promise<AppResult<T>> {
	const res = await operation;

	// We only act on FileSystemFailure types. Other errors are ignored by this specific handler.
	if (isErr(res) && isFileSystemFailure(res.error)) {
		const msg = ops?.message
			? typeof ops.message === "function"
				? ops.message(res.error)
				: ops.message
			: formatAppFailure(res.error);

		// Simple de-duplication to prevent notice spam for a session.
		const noticeKey = `kohl-notice-once:${ops?.onceKey}`;
		if (ops?.onceKey && sessionStorage.getItem(noticeKey)) {
			// Already shown this session, do nothing.
		} else {
			new Notice(msg, ops?.timeout ?? 7000);
			if (ops?.onceKey) {
				sessionStorage.setItem(noticeKey, "true");
			}
		}
	}
	return res;
}

// Helper guard to identify filesystem-related failures
function isFileSystemFailure(e: AppFailure): e is FileSystemFailure {
	const fsKinds = new Set([
		"NotFound",
		"PermissionDenied",
		"NotADirectory",
		"IsADirectory",
		"AlreadyExists",
		"NameTooLong",
		"WriteFailed",
		"ReadFailed",
	]);
	return fsKinds.has(e.kind);
}
