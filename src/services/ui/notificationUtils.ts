import { Notice } from "obsidian";
import { isErr, type Result } from "src/lib/core/result";
import type {
	AppFailure,
	AppResult,
	FileSystemFailure,
} from "src/lib/errors/types";
import { formatAppFailure } from "src/lib/errors/types";

/**
 * Awaits an AppResult-returning promise and shows a Notice on Err.
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
		let msg: string;
		if (ops?.message) {
			msg =
				typeof ops.message === "function"
					? ops.message(res.error as any)
					: ops.message;
		} else if (
			!!res.error &&
			typeof res.error === "object" &&
			"kind" in (res.error as any)
		) {
			msg = formatAppFailure(res.error as unknown as AppFailure);
		} else {
			const err = res.error;
			if (typeof err === "string") {
				msg = err;
			} else if (err instanceof Error) {
				msg = err.message;
			} else {
				try {
					msg = JSON.stringify(err);
				} catch {
					msg = "Operation failed";
				}
			}
		}
		new Notice(msg, ops?.timeout ?? 7000);
	}
	return res;
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

const FS_KINDS = new Set([
	"NotFound",
	"PermissionDenied",
	"NotADirectory",
	"IsADirectory",
	"AlreadyExists",
	"NameTooLong",
	"WriteFailed",
	"ReadFailed",
]);

function isFileSystemFailure(e: AppFailure): e is FileSystemFailure {
	return FS_KINDS.has(e.kind);
}
