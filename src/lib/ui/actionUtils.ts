// Minimal interface so callers can provide a ButtonComponent or a lightweight shim
// import type { ButtonComponent } from "obsidian";

import { type ButtonComponent, Notice } from "obsidian";
import { isErr, type Result } from "src/lib/core/result";

type LabelSet = { inProgress: string; original?: string };

function isButtonComponent(x: unknown): x is ButtonComponent {
	return (
		!!x &&
		typeof x === "object" &&
		"setDisabled" in (x as any) &&
		"setButtonText" in (x as any)
	);
}

/**
 * Shell-level helper: awaits a Result-returning promise and shows a Notice on Err.
 * Keeps core services free of UI concerns.
 */
export async function notifyOnError<T, E = any>(
	operation: Promise<Result<T, E>>,
	opts?: { message?: string | ((err: E) => string); timeout?: number },
): Promise<Result<T, E>> {
	const res = await operation;
	if (isErr(res)) {
		const msg =
			typeof opts?.message === "function"
				? opts.message(res.error as E)
				: (opts?.message ?? "Operation failed");
		new Notice(msg, opts?.timeout ?? 7000);
	}
	return res;
}

/**
 * Simplified async UI helper. Disables the component and updates its label while the action runs,
 * then restores the original state.
 */
export async function runAsyncAction<T>(
	component: ButtonComponent | HTMLElement,
	action: () => Promise<T>,
	labels: LabelSet,
): Promise<T> {
	if (isButtonComponent(component)) {
		const originalText = component.buttonEl?.innerText ?? "";
		component.setDisabled(true).setButtonText(labels.inProgress);
		try {
			return await action();
		} finally {
			component
				.setDisabled(false)
				.setButtonText(labels.original ?? originalText);
		}
	} else {
		const el = component as HTMLElement;
		const originalAria = el.ariaLabel ?? "";
		el.classList.add("is-disabled");
		el.style.pointerEvents = "none";
		el.ariaLabel = labels.inProgress;
		try {
			return await action();
		} finally {
			el.classList.remove("is-disabled");
			el.style.pointerEvents = "";
			el.ariaLabel = labels.original ?? originalAria;
		}
	}
}
