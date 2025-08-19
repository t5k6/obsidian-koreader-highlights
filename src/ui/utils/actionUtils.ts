// Minimal interface so callers can provide a ButtonComponent or a lightweight shim
// import type { ButtonComponent } from "obsidian";

import type { ButtonComponent } from "obsidian";

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
		// Avoid chaining to support simple mocks that return void
		component.setDisabled(true);
		component.setButtonText(labels.inProgress);
		try {
			return await action();
		} finally {
			component.setDisabled(false);
			component.setButtonText(labels.original ?? originalText);
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
