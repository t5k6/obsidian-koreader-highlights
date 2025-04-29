import path from "node:path";
import { Modal } from "obsidian";

export class ProgressModal extends Modal {
    private statusEl!: HTMLElement;
    private progressEl: HTMLProgressElement | null = null;
    private total: number | null = null;

    // constructor(app: App) {
    //     super(app);
    // }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Importing Highlights and Notes" });
        this.statusEl = contentEl.createEl("p", {
            text: "Collecting files...",
        });
    }

    setTotal(total: number) {
        this.total = total;
        this.statusEl.setText("Processing files...");
        this.progressEl = this.contentEl.createEl("progress", {
            attr: { max: total, value: 0 },
        });
    }

    updateProgress(completed: number, currentFile?: string) {
        if (this.progressEl) this.progressEl.value = completed;
        if (currentFile) {
            this.statusEl.setText(`Processing: ${path.basename(currentFile)}`);
        }
    }

}
