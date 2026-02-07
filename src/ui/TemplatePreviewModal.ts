import {
	type App,
	debounce,
	MarkdownRenderer,
	Notice,
	Setting,
	type TextAreaComponent,
} from "obsidian";
import { isTFile } from "src/lib/obsidian/typeguards";
import { compile, renderGroup } from "src/lib/templateCore";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { Annotation, TemplateDefinition } from "../types";
import { BaseModal } from "./BaseModal";

// --- Static Example Data (Unchanged) ---
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

export class TemplatePreviewModal extends BaseModal<boolean> {
	private editableContent: string;
	private readonly originalContent: string;
	private readonly isCustomTemplate: boolean;
	private readonly templatePath: string | null;

	private editorComponent!: TextAreaComponent;
	private previewEl!: HTMLElement;
	private debouncedRefresh: () => void;

	// Cache compiled template to avoid recompilation on every preview refresh
	private lastCompiledContent: string = "";
	private compiledTemplateFn?: (data: any) => string;

	constructor(
		app: App,
		private templateManager: TemplateManager,
		private template: Omit<TemplateDefinition, "id"> & { path?: string },
	) {
		super(app, {
			className: "koreader-template-editor-modal",
			enableEscape: true,
		});

		this.isCustomTemplate = !!template.path;
		this.templatePath = template.path ?? null;
		this.originalContent = template.content;
		this.editableContent = template.content;

		this.debouncedRefresh = debounce(() => this.refreshPreview(), 300, true);
	}

	protected renderContent(contentEl: HTMLElement): void {
		this.titleEl.setText(
			this.isCustomTemplate
				? `Edit: ${this.template.name}`
				: `Preview: ${this.template.name}`,
		);
		contentEl.createEl("p", { text: this.template.description });

		const mainContainer = contentEl.createDiv({
			cls: "koreader-editor-container",
		});

		// Left Pane: Editor
		const editorPane = mainContainer.createDiv({ cls: "koreader-editor-pane" });
		editorPane.createEl("h3", { text: "Template Code" });

		const editorSetting = new Setting(editorPane).addTextArea((text) => {
			this.editorComponent = text;
			text.setValue(this.editableContent).onChange((value) => {
				this.editableContent = value;
				this.debouncedRefresh();
			});

			text.inputEl.addClass("koreader-template-editor-textarea");

			if (!this.isCustomTemplate) {
				text.setDisabled(true);
				text.inputEl.title =
					"Built-in templates cannot be edited directly. Use 'Create from Built-in...' to make an editable copy.";
			}
		});

		editorSetting.settingEl.addClass("koreader-template-editor-setting");

		// Right Pane: Preview
		const previewPane = mainContainer.createDiv({
			cls: "koreader-preview-pane",
		});
		previewPane.createEl("h3", { text: "Live Preview" });
		this.previewEl = previewPane.createDiv({
			cls: "template-preview-rendered",
		});

		// Action Buttons
		this.createButtonRow(contentEl, [
			{
				text: "Save & Close",
				cta: true,
				disabled: !this.isCustomTemplate,
				onClick: () => this.handleSave(),
			},
			{
				text: "Revert",
				disabled: !this.isCustomTemplate,
				onClick: () => this.handleRevert(),
			},
			{
				text: "Close",
				onClick: () => this.cancel(),
			},
		]);

		// Initial render
		this.refreshPreview();
	}

	private async handleSave(): Promise<void> {
		if (!this.isCustomTemplate || !this.templatePath) return;

		const file = this.app.vault.getAbstractFileByPath(this.templatePath);
		if (!isTFile(file)) {
			new Notice(`Error: Template file not found at ${this.templatePath}`);
			return;
		}

		try {
			await this.app.vault.modify(file, this.editableContent);
			new Notice(`Template '${file.basename}' saved.`);
			this.resolveAndClose(true); // Signal that a save occurred
		} catch (error) {
			new Notice("Error saving template. See console for details.");
			console.error("Failed to save template:", error);
		}
	}

	private handleRevert(): void {
		if (!this.isCustomTemplate) return;
		this.editableContent = this.originalContent;
		this.editorComponent.setValue(this.originalContent);
		// Clear cache to force recompilation on revert
		this.lastCompiledContent = "";
		this.compiledTemplateFn = undefined;
		this.refreshPreview();
		new Notice("Changes have been reverted.");
	}

	private async refreshPreview(): Promise<void> {
		// If renderContent hasn't run correctly, avoid throwing from preview updates.
		if (!this.previewEl) return;

		this.previewEl.setText("Rendering…");
		await new Promise((resolve) => setTimeout(resolve, 10));

		// Only recompile if template content has changed
		if (this.editableContent !== this.lastCompiledContent) {
			try {
				this.compiledTemplateFn = compile(this.editableContent, {
					noteQuotingMode:
						this.templateManager.plugin.settings.template.noteQuotingMode,
				});
				this.lastCompiledContent = this.editableContent;
			} catch (e) {
				// Show compilation errors immediately
				this.previewEl.empty();
				this.previewEl.addClass("template-error");
				this.previewEl.setText(`Template Error:\n\n${(e as Error).message}`);
				return;
			}
		}

		// Fast path: render with cached compiled template
		if (!this.compiledTemplateFn) {
			this.previewEl.setText("Error: Template not compiled");
			return;
		}

		try {
			const renderedOutput = renderGroup(
				this.compiledTemplateFn,
				EXAMPLE_ANNOTATION_GROUP,
				EXAMPLE_RENDER_CONTEXT,
			);

			this.previewEl.empty();
			this.previewEl.removeClass("template-error");
			await MarkdownRenderer.render(
				this.app,
				renderedOutput,
				this.previewEl,
				this.template.name,
				this.templateManager.plugin,
			);
		} catch (e) {
			this.previewEl.setText(`Render Error:\n\n${(e as Error).message}`);
			this.previewEl.addClass("template-error");
		}
	}
}
