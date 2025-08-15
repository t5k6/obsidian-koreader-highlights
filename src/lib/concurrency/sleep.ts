export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const id = setTimeout(resolve, ms);
		if (signal) {
			const onAbort = () => {
				clearTimeout(id);
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}
