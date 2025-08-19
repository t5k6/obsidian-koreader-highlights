// Consolidated cancellation utilities: abort, sleep, and signal composition

// Abort helpers
export function abortError(message = "Operation cancelled by user"): Error {
	try {
		// Use the standard DOMException where available (browser/modern Node).
		return new DOMException(message, "AbortError");
	} catch {
		// Fallback for older environments.
		const error = new Error(message);
		(error as any).name = "AbortError";
		return error;
	}
}

export function isAbortError(error: unknown): boolean {
	return (
		!!error && typeof error === "object" && (error as any).name === "AbortError"
	);
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	// Normalize to a consistent AbortError message across environments
	throw abortError("Aborted by user");
}

// sleep with AbortSignal support
function bindAbort(
	signal: AbortSignal | undefined,
	onAbort: () => void,
): () => void {
	if (!signal) return () => {};
	if (signal.aborted) {
		onAbort();
		return () => {};
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? abortError());
			return;
		}

		let id: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(id);
			cleanup();
			reject(signal?.reason ?? abortError());
		};

		const cleanup = bindAbort(signal, onAbort);
		id = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
	});
}

// Compose multiple AbortSignals
export function composeAbortSignals(
	signals: (AbortSignal | undefined)[],
): AbortController {
	const controller = new AbortController();
	const validSignals = signals.filter((s): s is AbortSignal => !!s);

	const cleanup = () => {
		for (const s of validSignals) s.removeEventListener("abort", onAbort);
	};

	const onAbort = (e: Event) => {
		if (controller.signal.aborted) return;
		const source = e.target as AbortSignal;
		const reason = (source as any)?.reason ?? abortError("Aborted by user");
		controller.abort(reason);
		cleanup();
	};

	for (const s of validSignals) {
		if (s.aborted) {
			onAbort({ target: s } as unknown as Event);
			break;
		}
		s.addEventListener("abort", onAbort, { once: true });
	}

	controller.signal.addEventListener("abort", cleanup, { once: true });

	return controller;
}
