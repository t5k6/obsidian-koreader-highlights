import { type App, MarkdownRenderer } from "obsidian";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { Annotation, TemplateDefinition } from "../types";
import { BaseModal } from "./BaseModal";

const EXAMPLE_ANNOTATION_GROUP: Annotation[] = [
	{
		chapter: "The Beginning",
		datetime: new Date().toISOString(),
		pageno: 42,
		text: "This is a sample highlight text. It demonstrates how the main content of a highlight will look.",
		note: "This is a note attached to the highlight. It can contain extra thoughts or references.",
		pos0: "0",
		pos1: "1",
	},
];

const EXAMPLE_RENDER_CONTEXT = {
	isFirstInChapter: true,
	separators: [],
};

export class TemplatePreviewModal extends BaseModal<void> {
	constructor(
		app: App,
		private templateManager: TemplateManager,
		private template: Omit<TemplateDefinition, "id">,
	) {
		super(app, {
			className: "koreader-template-preview-modal",
			enableEscape: true,
			enableEnter: false,
		});
	}

	protected async renderContent(contentEl: HTMLElement): Promise<void> {
		contentEl.createEl("h2", { text: `Preview: ${this.template.name}` });
		contentEl.createEl("p", { text: this.template.description });

		contentEl.createEl("h3", { text: "Example Output" });
		const previewEl = contentEl.createDiv({ cls: "template-preview-rendered" });

		// --- Template Code Section ---
		contentEl.createEl("h3", { text: "Template Code" });
		const codeContainer = contentEl.createDiv({
			cls: "template-preview-code-block",
		});
		const markdownCodeBlock = `\`\`\`md\n${this.template.content}\n\`\`\``;

		await MarkdownRenderer.render(
			this.app,
			markdownCodeBlock,
			codeContainer,
			"",
			this.templateManager.plugin,
		);

		// --- Event Handlers for Live Refresh ---
		this.registerAppEvent(
			this.app.workspace.on("css-change", () => {
				this.refreshPreview(previewEl);
			}),
		);

		// Initial render after setting up events
		this.refreshPreview(previewEl);
	}

	protected registerShortcuts(): void {
		super.registerShortcuts(); // Handles Escape key
		this.registerShortcut(["Mod"], "w", () => this.close());
	}

	private async refreshPreview(el: HTMLElement): Promise<void> {
		el.setText("Rendering preview…");
		await new Promise((resolve) => setTimeout(resolve, 10));

		const compiledTemplateFn = this.templateManager.compile(
			this.template.content,
		);

		const renderedOutput = this.templateManager.renderGroup(
			compiledTemplateFn,
			EXAMPLE_ANNOTATION_GROUP,
			EXAMPLE_RENDER_CONTEXT,
		);

		el.empty();
		await MarkdownRenderer.render(
			this.app,
			renderedOutput,
			el,
			this.template.name,
			this.templateManager.plugin,
		);
	}
}
