import type { App } from "obsidian";
import { composeAbortSignals } from "src/lib/concurrency/cancellation";
import { ProgressModal } from "src/ui/ProgressModal";

type TickFn = ((message?: string) => void) & {
	setStatus: (message: string) => void;
	setTotal: (n: number) => void;
};

type WithProgressOptions = {
	title?: string;
	showWhenTotalIsZero?: boolean;
	autoMessage?: boolean;
	signal?: AbortSignal;
};

export function withProgress<T>(
	app: App,
	total: number | (() => number),
	runner: (tick: TickFn, signal: AbortSignal) => Promise<T>,
	options?: WithProgressOptions,
): Promise<T> {
	const initialTotal = typeof total === "function" ? total() : total;

	// Instantiate synchronously so tests can assert immediately.
	const modal = new ProgressModal(app, options?.title);

	const shouldOpen = Boolean(options?.showWhenTotalIsZero || initialTotal > 0);
	if (shouldOpen) {
		try {
			// Defensive: some test doubles may not implement open()
			(modal as any).open?.();
		} catch {
			/* ignore */
		}
	}

	let currentTotal = initialTotal;
	if (shouldOpen && initialTotal > 0) {
		try {
			modal.setTotal(initialTotal);
		} catch {
			/* ignore */
		}
	}

	let done = 0;
	let lastStatus = "";

	const setStatus = (message: string) => {
		if (message && message !== lastStatus) {
			lastStatus = message;
			try {
				(modal.statusEl as any)?.setText?.(message);
			} catch {
				if (modal.statusEl && "textContent" in modal.statusEl) {
					(modal.statusEl as any).textContent = message;
				}
			}
		}
	};

	const setTotal = (n: number) => {
		currentTotal = n;
		if (shouldOpen) {
			try {
				modal.setTotal(n);
			} catch {
				/* ignore */
			}
		}
	};

	const getAutoMessage = () =>
		options?.autoMessage === false || lastStatus
			? undefined
			: `${done}/${Math.max(currentTotal, done)} complete`;

	// Only update on tick — no initial update, no heartbeat timer.
	const tick = Object.assign(
		(message?: string) => {
			done++;
			if (message) setStatus(message);
			if (shouldOpen) {
				try {
					modal.updateProgress(done, getAutoMessage());
				} catch {
					/* ignore */
				}
			}
		},
		{ setStatus, setTotal },
	) as TickFn;

	const composed = composeAbortSignals([
		(modal as any).abortSignal,
		options?.signal,
	]);

	const p = runner(tick, composed.signal);

	return p.finally(() => {
		try {
			(modal as any).close?.();
		} catch {
			/* ignore */
		}
	});
}
