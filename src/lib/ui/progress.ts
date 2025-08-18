import type { App } from "obsidian";
import { ProgressModal } from "src/ui/ProgressModal";

type TickFn = ((message?: string) => void) & {
	setStatus: (message: string) => void;
	setTotal: (n: number) => void;
};

type WithProgressOptions = {
	title?: string;
	/**
	 * When true, show a modal even if the initial total is 0/unknown.
	 * Useful for "indeterminate" phases (scan, discovery) that may become determinate later.
	 */
	showWhenTotalIsZero?: boolean;
	/**
	 * When false, the helper will not auto-write status like "n/N processed"
	 * every tick, allowing caller-defined statuses to remain visible.
	 */
	autoMessage?: boolean;
};

/**
 * Wraps an asynchronous task with a progress modal.
 * If total is 0 and showWhenTotalIsZero is not set, runs without UI.
 */
export async function withProgress<T>(
	app: App,
	total: number | (() => number),
	runner: (tick: TickFn, signal: AbortSignal) => Promise<T>,
	options?: WithProgressOptions,
): Promise<T> {
	const initialTotal = typeof total === "function" ? total() : total;
	const shouldOpen = options?.showWhenTotalIsZero || initialTotal > 0;

	// If nothing to do and no UI requested, just run the task without UI.
	if (!shouldOpen) {
		const noopTick = Object.assign(() => {}, {
			setStatus: () => {},
			setTotal: () => {},
		});
		const controller = new AbortController();
		return runner(noopTick as TickFn, controller.signal);
	}

	const modal = new ProgressModal(app, options?.title);
	modal.open();

	let currentTotal = initialTotal;
	if (initialTotal > 0) {
		modal.setTotal(initialTotal);
	}

	let done = 0;
	let lastStatus = "";

	const setStatus = (message: string) => {
		if (message && message !== lastStatus) {
			lastStatus = message;
			modal.statusEl.setText(message);
		}
	};

	const setTotal = (n: number) => {
		currentTotal = n;
		modal.setTotal(n);
	};

	const tick = Object.assign(
		(message?: string) => {
			done++;
			if (message) setStatus(message);
		},
		{ setStatus, setTotal },
	) as TickFn;

	const timer = setInterval(() => {
		// Only auto-write a message if requested and no custom status is set.
		const autoMsg =
			options?.autoMessage === false || lastStatus
				? undefined
				: `${done}/${Math.max(currentTotal, done)} processed`;

		modal.updateProgress(done, autoMsg);
	}, 200);

	try {
		return await runner(tick, modal.abortSignal);
	} finally {
		clearInterval(timer);
		modal.close();
	}
}
