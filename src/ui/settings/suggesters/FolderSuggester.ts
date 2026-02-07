import { prepareFuzzySearch, type TFolder } from "obsidian";
import { TextInputSuggest } from "./suggest";

interface ScoredFolder {
	folder: TFolder;
	score: number;
	matchIndices?: number[];
}

export class FolderSuggest extends TextInputSuggest<ScoredFolder> {
	getSuggestions(inputStr: string): ScoredFolder[] {
		const query = (inputStr ?? "").trim();
		const folders: TFolder[] = this.app.vault.getAllFolders();

		if (query.length === 0) {
			// Suggest top-level folders for an empty query.
			return folders
				.filter((f) => f.parent?.isRoot()) // Correctly identify root folders
				.slice(0, 10)
				.map((folder) => ({ folder, score: 0 }));
		}

		const fuzzy = prepareFuzzySearch(query);
		const results: ScoredFolder[] = [];

		for (const folder of folders) {
			const match = fuzzy(folder.path);
			if (match) {
				const flat: number[] = [];
				for (const range of match.matches)
					for (let k = range[0]; k < range[1]; k++) flat.push(k);
				results.push({ folder, score: match.score, matchIndices: flat });
			}
		}

		results.sort((a, b) =>
			b.score !== a.score
				? b.score - a.score
				: a.folder.path.length - b.folder.path.length,
		);

		return results.slice(0, 20);
	}

	protected renderItem(item: ScoredFolder, el: HTMLElement): void {
		const path = `${item.folder.path}/`.replace("//", "/");
		if (item.matchIndices && item.matchIndices.length > 0) {
			this.highlightMatches(path, item.matchIndices, el);
		} else {
			el.setText(path);
		}
	}

	private highlightMatches(
		text: string,
		indices: number[],
		el: HTMLElement,
	): void {
		// Build DOM nodes to avoid any innerHTML injection risks
		const set = new Set(indices);
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			const span = el.createSpan({ text: ch }); // ensures escaping
			if (set.has(i)) span.addClass("suggestion-highlight");
		}
	}

	protected selectSuggestion(item: ScoredFolder): void {
		this.inputEl.value = item.folder.path;
		this.inputEl.trigger("input");
		// Trigger blur to ensure the setting is saved
		// Ensure the input value has been fully processed
		setTimeout(() => this.inputEl.blur(), 0);
		// close handled by SuggestionList onSelect
	}
}
