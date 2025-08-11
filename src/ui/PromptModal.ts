import { type App, Setting, type TextComponent } from "obsidian";
import { BaseModal } from "./BaseModal";

export class PromptModal extends BaseModal<string> {
	private value: string;
	private inputComponent!: TextComponent;

	constructor(
		app: App,
		title: string,
		private readonly placeholder: string,
		private readonly defaultValue: string = "",
	) {
		super(app, {
			title,
			className: "prompt-modal",
			enableEscape: true,
			enableEnter: true,
			focusOnOpen: true,
		});
		this.value = this.defaultValue;
	}

	public async openAndGetValue(): Promise<string | null> {
		return this.openAndAwaitResult();
	}

	protected renderContent(contentEl: HTMLElement): void {
		const { placeholder } = this;

		new Setting(contentEl).addText((text) => {
			this.inputComponent = text;
			text
				.setPlaceholder(placeholder)
				.setValue(this.value)
				.onChange((value) => {
					this.value = value;
				});

			// Select all on focus for quick overwrite
			text.inputEl.addEventListener("focus", () => {
				text.inputEl.select();
			});
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.cancel();
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Create")
					.setCta()
					.onClick(() => this.submit()),
			);
	}

	protected handleEnter(): void {
		this.submit();
	}

	protected getFocusElement(): HTMLElement | null {
		return this.inputComponent?.inputEl ?? null;
	}

	private submit(): void {
		const trimmedValue = this.value.trim();
		if (!trimmedValue) {
			return;
		}
		this.resolveAndClose(trimmedValue);
	}
}
