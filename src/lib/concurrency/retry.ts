import type { Vault } from "obsidian";
import { getFsCode } from "src/lib/errors/mapper";
import { abortError, sleep } from "./cancellation";

export type Jitter = "none" | "full";

export interface RetryOptions {
	/** Maximum number of attempts; default is 5 */
	maxAttempts?: number;
	/** Base delay in milliseconds; default is 50ms */
	baseDelayMs?: number;
	/** Maximum delay in milliseconds; default is 1000ms */
	maxDelayMs?: number;
	/** Exponential factor; default is 2 */
	factor?: number;
	/** Jitter strategy: "full" by default; boolean true maps to "full" */
	jitter?: Jitter | boolean;
	/**
	 * A predicate function that given an error and the attempt number,
	 * returns true if the error is transient and the retry loop should try again.
	 */
	shouldRetry?: (error: unknown, attempt: number) => boolean;
	/** Optional AbortSignal; aborts between attempts and cancels sleep */
	signal?: AbortSignal;
	/** Optional hook called before each retry sleep */
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

// ------------------------------------------------------------------------------------
// Filesystem-focused retry helpers (consolidated from fsRetry.ts)
// ------------------------------------------------------------------------------------

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
	if (!code) return true;
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
	return retry(fn, {
		...FS_RETRY_DEFAULTS,
		...opts,
		shouldRetry: (err: unknown, attempt: number) => {
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

/**
 * Retries the async function `fn` using exponential back-off.
 *
 * @param fn - The async function to run.
 * @param opts - Options to control back-off behavior.
 * @returns The resolved value of `fn` on eventual success.
 * @throws The last error from `fn` if all attempts fail.
 */
function computeDelay(
	attempt: number,
	cfg: Required<
		Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "factor" | "jitter">
	>,
): number {
	const { baseDelayMs, maxDelayMs, factor } = cfg;
	let delay = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
	const j =
		cfg.jitter === true ? "full" : cfg.jitter === false ? "none" : cfg.jitter;
	if (j === "full") {
		delay = Math.floor(Math.random() * delay);
	}
	return delay;
}

export async function retry<T>(
	fn: () => Promise<T>,
	opts?: RetryOptions,
): Promise<T> {
	const {
		maxAttempts = 5,
		baseDelayMs = 50,
		maxDelayMs = 1000,
		factor = 2,
		jitter = "full",
		shouldRetry = () => true,
		signal,
		onRetry,
	} = opts || {};

	if (maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
	if (baseDelayMs < 0 || maxDelayMs < 0) throw new Error("Delays must be >= 0");
	if (factor < 1) throw new Error("factor must be >= 1");

	let attempt = 0;
	while (true) {
		if (signal?.aborted) throw signal.reason ?? abortError();
		try {
			return await fn();
		} catch (err) {
			attempt++;
			let shouldAttemptRetry = true;
			if (attempt >= maxAttempts) {
				shouldAttemptRetry = false;
			} else {
				try {
					shouldAttemptRetry = shouldRetry(err, attempt);
				} catch {
					// Predicate threw; treat as "do not retry" and rethrow original error after
					shouldAttemptRetry = false;
				}
			}
			if (!shouldAttemptRetry) {
				throw err;
			}
			const delay = computeDelay(attempt, {
				baseDelayMs,
				maxDelayMs,
				factor,
				jitter,
			});
			onRetry?.(err, attempt, delay);
			await sleep(delay, signal);
		}
	}
}
