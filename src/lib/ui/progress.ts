import type { App } from "obsidian";
import { ProgressModal } from "src/ui/ProgressModal";

/**
 * Wraps an asynchronous task with a progress modal.
 * The runner receives a `tick` function that:
 *   - increments progress when called
 *   - accepts an optional status message
 *   - exposes tick.setStatus(msg) and tick.setTotal(n) helpers
 *
 * If total is 0, runs the runner without showing a modal.
 */
export async function withProgress<T>(
	app: App,
	total: number | (() => number),
	runner: (
		tick: ((message?: string) => void) & {
			setStatus: (message: string) => void;
			setTotal: (n: number) => void;
		},
		signal: AbortSignal,
	) => Promise<T>,
	options?: { title?: string },
): Promise<T> {
	const initialTotal = typeof total === "function" ? total() : total;

	// If nothing to do, just run the task without UI.
	if (initialTotal <= 0) {
		// Provide a no-op tick for consistency
		const noopTick = Object.assign(() => {}, {
			setStatus: () => {},
			setTotal: () => {},
		});
		// A dummy AbortController for interface parity (runner may ignore it)
		const controller = new AbortController();
		return runner(noopTick, controller.signal);
	}

	const modal = new ProgressModal(app, options?.title);
	modal.open();
	modal.setTotal(initialTotal);

	let currentTotal = initialTotal;

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
	);

	const timer = setInterval(
		() =>
			modal.updateProgress(
				done,
				`${done}/${Math.max(currentTotal, done)} processed`,
			),
		200,
	);

	try {
		return await runner(tick, modal.abortSignal);
	} finally {
		clearInterval(timer);
		modal.close();
	}
}
