import { type App, type EventRef, MarkdownRenderer, Modal } from "obsidian";
import type {
	CompiledTemplate,
	TemplateManager,
} from "src/services/parsing/TemplateManager";
import type { Annotation, TemplateDefinition } from "../types";

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
	private unregisterThemeHandler: EventRef | null = null;
	private compiledTemplateFn: CompiledTemplate;

	constructor(
		app: App,
		private templateManager: TemplateManager,
		private template: Omit<TemplateDefinition, "id">,
	) {
		super(app);
		// Pre-compile the template string for rendering
		this.compiledTemplateFn = (this.templateManager as any).compile(
			this.template.content,
		);
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("koreader-template-preview-modal");

		contentEl.createEl("h2", { text: `Preview: ${this.template.name}` });
		contentEl.createEl("p", { text: this.template.description });

		// --- Example Output Section ---
		contentEl.createEl("h3", { text: "Example Output" });
		const previewEl = contentEl.createDiv({ cls: "template-preview-rendered" });
		this.refreshPreview(previewEl); // Initial render

		// --- Template Code Section (Using MarkdownRenderer) ---
		contentEl.createEl("h3", { text: "Template Code" });
		const codeContainer = contentEl.createDiv();
		const markdownCodeBlock = `\`\`\`md\n${this.template.content}\n\`\`\``;

		await MarkdownRenderer.render(
			this.app,
			markdownCodeBlock,
			codeContainer,
			"", // No source path needed
			this.templateManager.plugin,
		);
		// The renderer creates its own <pre> and <code> tags.
		// We can add a class to the container for styling.
		codeContainer.addClass("template-preview-code-block");

		// --- Event Handlers & Shortcuts ---
		this.scope.register([], "Escape", () => {
			this.close();
			return false;
		});
		this.scope.register(["Mod"], "w", () => {
			this.close();
			return false;
		});

		this.unregisterThemeHandler = this.app.workspace.on("css-change", () => {
			this.refreshPreview(previewEl);
		});
	}

	onClose() {
		super.onClose();
		if (this.unregisterThemeHandler) {
			this.app.workspace.offref(this.unregisterThemeHandler);
		}
	}

	private async refreshPreview(el: HTMLElement) {
		el.setText("Rendering preview…"); // Placeholder text

		// Give the UI a moment to update before we do the work
		await new Promise((resolve) => setTimeout(resolve, 10));

		const renderedOutput = this.templateManager.renderGroup(
			this.compiledTemplateFn,
			EXAMPLE_ANNOTATION_GROUP,
			EXAMPLE_RENDER_CONTEXT,
		);

		el.empty(); // Clear the placeholder

		// Render the final HTML
		await MarkdownRenderer.render(
			this.app,
			renderedOutput,
			el,
			this.template.name, // Use a dummy path for context
			this.templateManager.plugin,
		);
	}
}
