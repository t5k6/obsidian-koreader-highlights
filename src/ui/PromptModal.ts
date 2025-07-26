import { type App, Modal, Setting, type TextComponent } from "obsidian";

export class PromptModal extends Modal {
	private value: string;
	private resolvePromise!: (value: string | null) => void;
	private inputComponent!: TextComponent;
	private didSubmit = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly placeholder: string,
		private readonly defaultValue: string = "",
	) {
		super(app);
		this.value = this.defaultValue;
	}

	public async openAndGetValue(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen() {
		this.contentEl.empty();
		this.titleEl.setText(this.title);

		new Setting(this.contentEl).addText((text) => {
			this.inputComponent = text;
			text
				.setPlaceholder(this.placeholder)
				.setValue(this.value)
				.onChange((value) => {
					this.value = value;
				});

			text.inputEl.focus();
			text.inputEl.select();
			text.inputEl.addEventListener("keydown", this.handleKeydown);
		});

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Create").setCta().onClick(this.handleSubmit),
			);
	}

	onClose() {
		if (!this.didSubmit) {
			this.resolvePromise(null);
		}
		if (this.inputComponent) {
			this.inputComponent.inputEl.removeEventListener(
				"keydown",
				this.handleKeydown,
			);
		}
		this.contentEl.empty();
	}

	private handleKeydown = (e: KeyboardEvent): void => {
		if (e.key === "Enter") {
			e.preventDefault();
			this.handleSubmit();
		}
	};

	private handleSubmit = (): void => {
		const trimmedValue = this.value.trim();
		if (!trimmedValue) {
			return;
		}
		this.didSubmit = true;
		this.resolvePromise(trimmedValue);
		this.close();
	};
}
