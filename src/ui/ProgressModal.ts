import path from "node:path";
import { type App, ButtonComponent, Modal } from "obsidian";

export class ProgressModal extends Modal {
	public statusEl!: HTMLElement;
	private progressEl: HTMLProgressElement | null = null;
	private total: number | null = null;
	private controller: AbortController;

	constructor(app: App) {
		super(app);
		this.controller = new AbortController();
	}

	public get abortSignal(): AbortSignal {
		return this.controller.signal;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Importing Highlights and Notes");
		this.statusEl = contentEl.createEl("p", {
			text: "Collecting files...",
		});

		// Add a cancel button
		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});
		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.setWarning()
			.onClick(() => {
				this.controller.abort();
				this.close();
			});
	}

	onClose() {
		// If the modal is closed by the user (e.g., pressing Esc), also trigger the abort.
		if (!this.controller.signal.aborted) {
			this.controller.abort();
		}
		super.onClose();
	}

	setTotal(total: number) {
		this.total = total;
		this.statusEl.setText("Processing files...");
		this.progressEl = this.contentEl.createEl("progress", {
			attr: { max: total, value: 0 },
		});
	}

	updateProgress(completed: number, currentFile?: string) {
		if (this.progressEl && this.total) {
			this.progressEl.value = completed;
			const percentage = Math.round((completed / this.total) * 100);
			this.titleEl.setText(`Importing... (${percentage}%)`);
		}
		if (currentFile) {
			this.statusEl.setText(`Processing: ${path.basename(currentFile)}`);
		}
	}
}
