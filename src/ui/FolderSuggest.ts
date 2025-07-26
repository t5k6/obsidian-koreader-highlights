import { AbstractInputSuggest, type App, type Plugin, TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<string> {
	private folderCache: string[] = [];

	constructor(
		app: App,
		private plugin: Plugin,
		inputEl: HTMLInputElement,
		private onSubmit: (result: string) => void,
	) {
		super(app, inputEl);
		this.buildCache();
		this.registerVaultEvents();
	}

	private buildCache(): void {
		this.folderCache = this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.map((f) => f.path)
			.sort();
	}

	private registerVaultEvents(): void {
		this.app.workspace.onLayoutReady(() => {
			const rebuild = () => this.buildCache();
			this.plugin.registerEvent(this.app.vault.on("create", rebuild));
			this.plugin.registerEvent(this.app.vault.on("delete", rebuild));
			this.plugin.registerEvent(this.app.vault.on("rename", rebuild));
		});
	}

	renderSuggestion(suggestion: string, el: HTMLElement): void {
		el.createDiv({ text: suggestion });
	}

	selectSuggestion(suggestion: string): void {
		this.onSubmit(suggestion);
		this.close();
	}

	getSuggestions(query: string): string[] {
		const lowerCaseQuery = query.toLowerCase();
		if (!query) return this.folderCache; // Show all folders on empty query
		return this.folderCache.filter((folderPath) =>
			folderPath.toLowerCase().includes(lowerCaseQuery),
		);
	}
}
