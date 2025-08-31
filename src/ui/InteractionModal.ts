import { type App, Setting, type TextComponent } from "obsidian";
import { BaseModal } from "./BaseModal";
import { createApplyToAllToggle } from "./utils/modalComponents";

// --- Type-Safe Configuration (Discriminated Union) ---

type InteractionModalConfig =
	| {
			mode: "confirm";
			title: string;
			message: string;
			ctaText?: string;
			cancelText?: string;
			placeholder?: string;
			session?: { applyToAll: boolean };
	  }
	| {
			mode: "prompt";
			title: string;
			message?: string;
			placeholder?: string;
			defaultValue?: string;
			session?: { applyToAll: boolean };
	  }
	| {
			mode: "choice";
			title: string;
			message: string;
			placeholder?: string;
			choices: Array<{
				value: string;
				label: string;
				cta?: boolean;
				warning?: boolean;
			}>;
			session?: { applyToAll: boolean }; // Optional support for "Apply to all"
	  };

// --- Type-Safe Result ---

type InteractionModalResult<C extends InteractionModalConfig> =
	C["mode"] extends "confirm"
		? boolean
		: C["mode"] extends "prompt"
			? string | null
			: C["mode"] extends "choice"
				? { choice: string | null; applyToAll: boolean }
				: never;

/**
 * A consolidated, type-safe modal for common user interactions like prompts and confirmations.
 * Replaces multiple single-purpose modal classes.
 */
export class InteractionModal<
	C extends InteractionModalConfig,
> extends BaseModal<InteractionModalResult<C>> {
	private value: string;
	private inputComponent?: TextComponent;

	// Renamed constructor property from 'config' to 'options' to avoid conflict with BaseModal.
	private constructor(
		app: App,
		private options: C,
	) {
		super(app, { title: options.title, enableEnter: true, focusOnOpen: true });
		this.value =
			this.options.mode === "prompt" ? (this.options.defaultValue ?? "") : "";
	}

	// --- Static Factory Methods for Clean Usage ---

	public static async prompt(
		app: App,
		options: {
			title: string;
			message?: string;
			placeholder?: string;
			defaultValue?: string;
		},
	): Promise<string | null> {
		const modal = new InteractionModal(app, { mode: "prompt", ...options });
		return modal.openAndAwaitResult();
	}

	public static async confirm(
		app: App,
		options: {
			title: string;
			message: string;
			ctaText?: string;
			cancelText?: string;
		},
	): Promise<boolean> {
		const modal = new InteractionModal(app, { mode: "confirm", ...options });
		const result = await modal.openAndAwaitResult();
		return result ?? false;
	}

	public static async choice<T extends string>(
		app: App,
		options: Omit<Extract<InteractionModalConfig, { mode: "choice" }>, "mode">,
	): Promise<{ choice: T | null; applyToAll: boolean }> {
		const modal = new InteractionModal(app, { mode: "choice", ...options });
		const res = (await modal.openAndAwaitResult()) as {
			choice: string | null;
			applyToAll: boolean;
		} | null;
		return {
			choice: (res?.choice as T | null) ?? null,
			applyToAll: res?.applyToAll ?? options.session?.applyToAll ?? false,
		};
	}

	// --- Internal Rendering and Logic ---

	protected renderContent(contentEl: HTMLElement): void {
		if (this.options.message) {
			contentEl.createEl("p", { text: this.options.message });
		}

		switch (this.options.mode) {
			case "confirm":
				this.createButtonRow(contentEl, [
					{
						text: this.options.cancelText ?? "Cancel",
						onClick: () => this.resolveAndClose(false as any),
					},
					{
						text: this.options.ctaText ?? "Proceed",
						cta: true,
						onClick: () => this.resolveAndClose(true as any),
					},
				]);
				break;

			case "prompt": {
				// Capture the narrowed type in a constant before the callback.
				const options = this.options;
				new Setting(contentEl).addText((text: TextComponent) => {
					this.inputComponent = text;
					text
						// Now we use the constant `options`, whose type is correctly narrowed to the 'prompt' config.
						.setPlaceholder(options.placeholder ?? "")
						.setValue(this.value)
						.onChange((v) => {
							this.value = v;
						});
					text.inputEl.addEventListener("focus", () => text.inputEl.select());
				});
				this.createButtonRow(contentEl, [
					{ text: "Cancel", onClick: () => this.resolveAndClose(null as any) },
					{ text: "Submit", cta: true, onClick: () => this.submitPrompt() },
				]);
				break;
			}

			case "choice": {
				const buttons = this.options.choices.map((c) => ({
					text: c.label,
					cta: c.cta,
					warning: c.warning,
					onClick: () =>
						this.resolveAndClose({
							choice: c.value,
							// The toggle directly mutates the session object.
							applyToAll: this.options.session?.applyToAll ?? false,
						} as any),
				}));
				this.createButtonRow(contentEl, buttons);

				// Conditionally render the "Apply to all" toggle if a session is provided.
				if (this.options.session) {
					createApplyToAllToggle(contentEl, this.options.session);
				}
				break;
			}
		}
	}

	protected getFocusElement(): HTMLElement | null {
		return this.inputComponent?.inputEl ?? super.getFocusElement();
	}

	protected handleEnter(): void {
		if (this.options.mode === "prompt") {
			this.submitPrompt();
		} else {
			super.handleEnter();
		}
	}

	private submitPrompt(): void {
		const trimmed = this.value.trim();
		this.resolveAndClose(
			(trimmed ? trimmed : null) as InteractionModalResult<C>,
		);
	}
}
