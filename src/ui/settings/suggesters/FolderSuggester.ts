import {
	type App,
	debounce,
	prepareFuzzySearch,
	type TAbstractFile,
	TFolder,
} from "obsidian";
import { TextInputSuggest } from "./suggest";

interface ScoredFolder {
	folder: TFolder;
	score: number;
	matchIndices?: number[];
}

export class FolderSuggest extends TextInputSuggest<ScoredFolder> {
	private cachedFolders: TFolder[] = [];
	private folderPaths: string[] = [];

	constructor(app: App, inputEl: HTMLInputElement | HTMLTextAreaElement) {
		super(app, inputEl);

		// Incremental updates on vault changes
		this.registerEvent(this.app.vault.on("create", this.handleCreate));
		this.registerEvent(this.app.vault.on("delete", this.handleDelete));
		this.registerEvent(this.app.vault.on("rename", this.handleRename));
	}

	// Lazy init to avoid upfront work
	private ensureCache(): void {
		if (this.cachedFolders.length === 0) this.buildCache();
	}

	private buildCache(): void {
		const allFiles = this.app.vault.getAllLoadedFiles();
		const folders: TFolder[] = [];
		const paths: string[] = [];

		for (const f of allFiles) {
			if (f instanceof TFolder) {
				folders.push(f);
				paths.push(f.path.toLowerCase());
			}
		}

		this.cachedFolders = folders;
		this.folderPaths = paths;
	}

	private readonly handleCreate = (file: TAbstractFile) => {
		if (file instanceof TFolder) {
			this.cachedFolders.push(file);
			this.folderPaths.push(file.path.toLowerCase());
		}
	};

	private readonly handleDelete = (file: TAbstractFile) => {
		if (file instanceof TFolder) {
			const idx = this.cachedFolders.indexOf(file);
			if (idx >= 0) {
				this.cachedFolders.splice(idx, 1);
				this.folderPaths.splice(idx, 1);
			} else {
				// Fallback: rebuild if index not found (rename/delete edge cases)
				this.debouncedRebuild();
			}
		}
	};

	private readonly handleRename = (_file: TAbstractFile, _oldPath?: string) => {
		// Paths changed; safest is to rebuild lazily
		this.debouncedRebuild();
	};

	private debouncedRebuild = debounce(() => this.buildCache(), 300);

	getSuggestions(inputStr: string): ScoredFolder[] {
		this.ensureCache();

		const query = (inputStr ?? "").trim();
		if (query.length === 0) {
			// Show top-level folders (no '/')
			return this.cachedFolders
				.filter((f) => !f.path.includes("/"))
				.slice(0, 10)
				.map((folder) => ({ folder, score: 0 }));
		}

		const fuzzy = prepareFuzzySearch(query);
		const results: ScoredFolder[] = [];

		for (let i = 0; i < this.cachedFolders.length; i++) {
			const folder = this.cachedFolders[i];
			const path = folder.path;

			// Exact and prefix boosts handled post by score + length
			const match = fuzzy(path);
			if (match) {
				const flat: number[] = [];
				for (const range of match.matches) {
					// matches are [start, end]; include all indices in range
					for (let k = range[0]; k < range[1]; k++) flat.push(k);
				}
				results.push({ folder, score: match.score, matchIndices: flat });
			}
		}

		// Prefer higher score, then shorter path, then earlier segments
		results.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.folder.path.length - b.folder.path.length;
		});

		return results.slice(0, 20);
	}

	renderSuggestion(item: ScoredFolder, el: HTMLElement): void {
		const path = (item.folder.path + "/").replace("//", "/");
		if (item.matchIndices && item.matchIndices.length > 0) {
			el.innerHTML = this.highlightMatches(path, item.matchIndices);
		} else {
			el.setText(path);
		}
	}

	private highlightMatches(text: string, indices: number[]): string {
		const set = new Set(indices);
		let out = "";
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (set.has(i)) out += `<span class="suggestion-highlight">${ch}</span>`;
			else out += ch;
		}
		return out;
	}

	selectSuggestion(item: ScoredFolder): void {
		this.inputEl.value = item.folder.path;
		this.inputEl.trigger("input");
		this.close();
	}
}
