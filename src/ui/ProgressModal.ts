import path from "node:path";
import type { App } from "obsidian";
import { BaseModal } from "./BaseModal";

export class ProgressModal extends BaseModal<void> {
	public statusEl!: HTMLElement;
	private progressEl: HTMLProgressElement | null = null;
	private total: number | null = null;
	private controller: AbortController;
	private baseTitle: string;

	constructor(app: App, title?: string) {
		super(app, { title: title ?? "Importing Highlights and Notes" });
		this.controller = new AbortController();
		this.baseTitle = this.config.title;
	}

	public get abortSignal(): AbortSignal {
		return this.controller.signal;
	}

	protected renderContent(contentEl: HTMLElement): void {
		this.titleEl.setText(this.baseTitle);
		this.statusEl = contentEl.createEl("p", {
			text: "Collecting files...",
		});

		this.createButtonRow(contentEl, [
			{ text: "Cancel", warning: true, onClick: () => this.cancelAndAbort() },
		]);
	}

	protected onCleanup(): void {
		if (!this.controller.signal.aborted) {
			this.controller.abort();
		}
	}

	private cancelAndAbort(): void {
		if (!this.controller.signal.aborted) {
			this.controller.abort();
		}
		this.cancel();
	}

	setTotal(total: number) {
		this.total = total;
		this.statusEl.setText("Processing files...");
		this.progressEl = this.contentEl.createEl("progress", {
			attr: { max: total, value: 0 },
		});
	}

	updateProgress(completed: number, currentFileOrMessage?: string) {
		if (this.progressEl && this.total) {
			this.progressEl.value = completed;
			const percentage = Math.round((completed / this.total) * 100);
			this.titleEl.setText(`${this.baseTitle} (${percentage}%)`);
		}
		if (currentFileOrMessage) {
			// If it's a path, show basename; otherwise show the message as-is
			const maybeBasename = /[\\/]/.test(currentFileOrMessage)
				? path.basename(currentFileOrMessage)
				: currentFileOrMessage;
			this.statusEl.setText(`Processing: ${maybeBasename}`);
		}
	}
}
