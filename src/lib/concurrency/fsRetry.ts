import type { Vault } from "obsidian";
import { type RetryOptions, retryAsync } from "./retryAsync";

// Try to extract a recognizable error code from FileSystemError,
// NodeJS.ErrnoException, or message fallbacks.
export function getFsCode(e: unknown): string | undefined {
	const maybe: any = e;
	if (typeof maybe?.code === "string") return maybe.code;

	const msg: string | undefined =
		typeof maybe?.message === "string" ? maybe.message : undefined;
	if (msg) {
		// Pull out E* codes seen in Node/electron adapters if present.
		const m = msg.match(/\b(E[A-Z0-9]{2,})\b/);
		if (m) return m[1];
	}
	return undefined;
}

/**
 * Broadly classify transient FS errors for retry.
 * - EPERM/EACCES are often transient on Windows when files are locked by AV/editors.
 * - ENOENT can be transient in rename/write races (tmp/target created/removed between steps).
 * - EEXIST can be transient in rename-over-existing sequences.
 * - EBUSY/ETXTBSY/EAGAIN/EMFILE/ENFILE/UNKNOWN are treated as transient.
 * Being conservative here makes critical I/O much more robust.
 */
const TRANSIENT = new Set([
	"EPERM",
	"EACCES",
	"ENOENT",
	"EEXIST",
	"EBUSY",
	"ETXTBSY",
	"EAGAIN",
	"EMFILE",
	"ENFILE",
	"EIO",
	"EPIPE",
	"UNKNOWN",
]);

export function isTransientFsError(e: unknown): boolean {
	const code = getFsCode(e);
	if (!code) return true; // Unknown error shape: prefer retry conservatively
	return TRANSIENT.has(code);
}

// Shared default retry policy for filesystem operations.
// Centralize here so we can tune globally.
export const FS_RETRY_DEFAULTS: RetryOptions = {
	maxAttempts: 6,
	baseDelayMs: 40,
	factor: 2,
	jitter: true,
};

export async function withFsRetry<T>(
	fn: () => Promise<T>,
	opts?: RetryOptions,
): Promise<T> {
	return retryAsync(fn, {
		...FS_RETRY_DEFAULTS,
		...opts,
		shouldRetry: (err, attempt) => {
			// Allow call-sites to further restrict retries.
			const user = opts?.shouldRetry?.(err, attempt);
			if (user === false) return false;
			if (user === true) return true;
			return isTransientFsError(err);
		},
	});
}

// Convenience wrappers with sensible defaults, overridable via opts.
export async function renameWithRetry(
	adapter: Vault["adapter"],
	from: string,
	to: string,
	opts?: RetryOptions,
): Promise<void> {
	await withFsRetry(() => adapter.rename(from, to), opts);
}

export async function removeWithRetry(
	adapter: Vault["adapter"],
	target: string,
	opts?: RetryOptions,
): Promise<void> {
	await withFsRetry(async () => {
		try {
			await adapter.remove(target);
		} catch (e) {
			if (getFsCode(e) === "ENOENT") return; // idempotent remove
			throw e;
		}
	}, opts);
}

export async function writeBinaryWithRetry(
	adapter: Vault["adapter"],
	to: string,
	data: ArrayBuffer,
	opts?: RetryOptions,
): Promise<void> {
	await withFsRetry(() => adapter.writeBinary(to, data), opts);
}

export async function readWithRetry(
	adapter: Vault["adapter"],
	from: string,
	opts?: RetryOptions,
): Promise<ArrayBuffer> {
	return withFsRetry(() => adapter.readBinary(from), opts);
}
