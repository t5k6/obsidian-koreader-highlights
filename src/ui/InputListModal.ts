import {
	type App,
	ButtonComponent,
	Setting,
	type TextAreaComponent,
} from "obsidian";
import { BaseModal } from "./BaseModal";

export class InputListModal extends BaseModal<string[]> {
	private items: string[] = [];
	private textArea: TextAreaComponent | null = null;

	private validationEl: HTMLElement | null = null;
	private submitBtn: ButtonComponent | null = null;

	constructor(
		app: App,
		title: string,
		private options: {
			placeholder?: string;
			initialItems?: string[];
			validator?: (items: string[]) => string | null;
		} = {},
	) {
		super(app, {
			title,
			className: "input-list-modal",
			enableEnter: false, // keep Enter for newlines in textarea
			focusOnOpen: true,
		});

		this.items = options.initialItems || [];
	}

	protected renderContent(contentEl: HTMLElement): void {
		contentEl.createEl("p", {
			text: "Enter one item per line:",
			cls: "input-list-instructions",
		});

		new Setting(contentEl).addTextArea((textarea) => {
			this.textArea = textarea;
			textarea
				.setPlaceholder(this.options.placeholder || "")
				.setValue(this.items.join("\n"))
				.onChange((value) => {
					this.items = value
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean);
					this.updateValidation();
				});

			textarea.inputEl.rows = 10;
			textarea.inputEl.cols = 50;
		});

		const validationEl = contentEl.createDiv({ cls: "input-list-validation" });
		this.validationEl = validationEl;

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => this.cancel());

		this.submitBtn = new ButtonComponent(buttonContainer)
			.setButtonText("Save")
			.setCta()
			.onClick(() => this.submit());

		// Initial validation state
		this.updateValidation();
	}

	protected getFocusElement(): HTMLElement | null {
		return this.textArea?.inputEl ?? null;
	}

	private updateValidation(): void {
		if (!this.options.validator || !this.validationEl || !this.submitBtn)
			return;

		const error = this.options.validator(this.items);
		if (error) {
			this.validationEl.setText(error);
			this.validationEl.addClass("has-error");
			this.submitBtn.setDisabled(true);
		} else {
			this.validationEl.setText("");
			this.validationEl.removeClass("has-error");
			this.submitBtn.setDisabled(false);
		}
	}

	private submit(): void {
		if (this.options.validator) {
			const error = this.options.validator(this.items);
			if (error) return;
		}
		this.resolveAndClose(this.items);
	}
}
