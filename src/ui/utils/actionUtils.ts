import type { ButtonComponent } from "obsidian";

type LabelSet = { inProgress: string; original?: string };

/**
 * Interface for components that can be disabled and have button text
 */
interface ButtonLike {
	setDisabled(disabled: boolean): void;
	setButtonText(text: string): void;
	buttonEl?: { innerText?: string };
}

/**
 * Type guard for ButtonComponent with safer property checking
 */
function isButtonComponent(x: unknown): x is ButtonComponent & ButtonLike {
	return (
		!!x &&
		typeof x === "object" &&
		x !== null &&
		typeof (x as ButtonLike).setDisabled === "function" &&
		typeof (x as ButtonLike).setButtonText === "function"
	);
}

/**
 * Type guard for HTMLElement
 */
function isHTMLElement(x: unknown): x is HTMLElement {
	return x instanceof HTMLElement;
}

/**
 * Simplified async UI helper. Disables the component and updates its label while the action runs,
 * then restores the original state.
 * Supports both ButtonComponent and HTMLElement with proper error handling.
 */
export async function runAsyncAction<T>(
	component: ButtonComponent | HTMLElement,
	action: () => Promise<T>,
	labels: LabelSet,
): Promise<T> {
	if (!component) {
		throw new Error("Component is required for runAsyncAction");
	}

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
	} else if (isHTMLElement(component)) {
		const el = component;
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
	} else {
		// Handle unsupported component types gracefully
		console.warn("runAsyncAction: Unsupported component type", component);
		// Fallback: just run the action without UI state management
		return await action();
	}
}
