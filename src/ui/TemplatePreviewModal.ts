import { type App, MarkdownRenderer, Modal } from "obsidian";
import type { TemplateManager } from "src/services/TemplateManager";
import type { Annotation, TemplateDefinition } from "src/types";

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

export class TemplatePreviewModal extends Modal {
	constructor(
		app: App,
		private templateManager: TemplateManager,
		private template: Omit<TemplateDefinition, "id">,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("koreader-template-preview-modal");

		contentEl.createEl("h2", { text: `Preview: ${this.template.name}` });
		contentEl.createEl("p", { text: this.template.description });

		contentEl.createEl("h3", { text: "Example Output" });
		const previewEl = contentEl.createDiv({ cls: "template-preview-rendered" });

		const renderedOutput = this.templateManager.renderGroup(
			this.template.content,
			EXAMPLE_ANNOTATION_GROUP,
			EXAMPLE_RENDER_CONTEXT,
		);

		MarkdownRenderer.render(
			this.app,
			renderedOutput,
			previewEl,
			this.template.name,
			this.templateManager.plugin,
		);

		contentEl.createEl("h3", { text: "Template Code" });
		const codeBlock = contentEl.createEl("pre");
		codeBlock.createEl("code", { text: this.template.content });
	}
}
