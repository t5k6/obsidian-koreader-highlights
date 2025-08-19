/**
 * Wraps an async operation with a timeout using AbortSignal.
 * Simpler than a full pool implementation when you just need timeout behavior.
 */
export async function withTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
): Promise<{ result?: T; timedOut: boolean }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
		onTimeout?.();
	}, timeoutMs);

	try {
		const result = await operation(controller.signal);
		return { result, timedOut: false };
	} catch (error) {
		if (controller.signal.aborted) {
			return { timedOut: true };
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}
