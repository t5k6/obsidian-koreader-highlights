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

	private ensureStatusEl(): void {
		if (!this.statusEl) {
			const ce: any = (this as any).contentEl;
			if (ce && typeof ce.createEl === "function") {
				this.statusEl = ce.createEl("p", { text: "" });
			} else {
				this.statusEl = document?.createElement?.("p") ?? ({} as any);
			}
		}
	}

	private setStatus(text: string): void {
		this.ensureStatusEl();
		const el: any = this.statusEl as any;
		if (el && typeof el.setText === "function") el.setText(text);
		else if (el) el.textContent = text;
	}

	public get abortSignal(): AbortSignal {
		return this.controller.signal;
	}

	protected renderContent(contentEl: HTMLElement): void {
		if (this.titleEl && (this.titleEl as any).setText) {
			(this.titleEl as any).setText(this.baseTitle);
		}
		// Prefer Obsidian helper; fallback for test envs missing it
		if ((contentEl as any).createEl) {
			this.statusEl = (contentEl as any).createEl("p", {
				text: "Collecting files...",
			});
		} else {
			this.statusEl = document?.createElement?.("p") ?? ({} as any);
			if ("textContent" in (this.statusEl as any)) {
				(this.statusEl as any).textContent = "Collecting files...";
			}
		}

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
		this.setStatus("Processing files...");
		// Create progress element using Obsidian helper if present; fallback to DOM API
		const ce: any = (this as any).contentEl;
		if (ce && typeof ce.createEl === "function") {
			this.progressEl = ce.createEl("progress", {
				attr: { max: total, value: 0 },
			});
		} else {
			const prog = document?.createElement?.("progress") as
				| HTMLProgressElement
				| undefined;
			if (prog) {
				prog.max = total;
				prog.value = 0;
				this.progressEl = prog;
				// Try to append somewhere reasonable in tests
				const parent: any = ce ?? document?.body;
				if (parent && parent.appendChild && prog) parent.appendChild(prog);
			}
		}
	}

	updateProgress(completed: number, currentFileOrMessage?: string) {
		if (this.progressEl && this.total) {
			this.progressEl.value = completed;
			const percentage = Math.round((completed / this.total) * 100);
			if (this.titleEl && (this.titleEl as any).setText) {
				(this.titleEl as any).setText(`${this.baseTitle} (${percentage}%)`);
			}
		}
		if (currentFileOrMessage) {
			// If it's a path, show basename; otherwise show the message as-is
			const maybeBasename = /[\\/]/.test(currentFileOrMessage)
				? path.basename(currentFileOrMessage)
				: currentFileOrMessage;
			this.setStatus(`Processing: ${maybeBasename}`);
		}
	}
}
