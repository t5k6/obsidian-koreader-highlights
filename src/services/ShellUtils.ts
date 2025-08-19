import { Notice } from "obsidian";
import { isErr, type Result } from "src/lib/core/result";
import type { AppFailure, AppResult } from "src/lib/errors";
import { formatAppFailure } from "src/lib/errors";

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
