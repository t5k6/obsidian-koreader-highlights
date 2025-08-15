import { sleep } from "./sleep";

export type Jitter = "none" | "full" | "decorrelated";

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
	const jitter = cfg.jitter === true ? "full" : (cfg.jitter ?? "none");
	if (jitter === "full") {
		delay = Math.floor(Math.random() * delay);
	} else if (jitter === "decorrelated") {
		// Simple decorrelated jitter variant; can be refined if needed
		const min = baseDelayMs;
		const max = Math.max(min, Math.min(maxDelayMs, delay * 3));
		delay = Math.floor(min + Math.random() * (max - min));
	}
	return delay;
}

export async function retryAsync<T>(
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
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (signal?.aborted)
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
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
