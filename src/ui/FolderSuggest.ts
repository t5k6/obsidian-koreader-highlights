import { AbstractInputSuggest, type App, debounce, TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<string> {
	private folderCache: string[] = [];

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private onSubmit: (result: string) => void,
	) {
		super(app, inputEl);
		this.refreshCache(); // Initial cache population
	}

	// Debounced refresh to avoid performance issues on rapid file changes.
	public refreshCache = debounce(
		() => {
			this.folderCache = this.app.vault
				.getAllLoadedFiles()
				.filter((file): file is TFolder => file instanceof TFolder)
				.map((folder) => folder.path)
				.sort();
		},
		250,
		true,
	);

	getSuggestions(query: string): string[] {
		const lowerCaseQuery = query.toLowerCase();
		return this.folderCache.filter((folderPath) =>
			folderPath.toLowerCase().includes(lowerCaseQuery),
		);
	}

	renderSuggestion(suggestion: string, el: HTMLElement): void {
		el.createDiv({ text: suggestion });
	}

	selectSuggestion(suggestion: string): void {
		this.onSubmit(suggestion);
		this.close();
	}
}
