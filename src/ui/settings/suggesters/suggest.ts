// Credits go to Liam's Periodic Notes Plugin: https://github.com/liamcain/obsidian-periodic-notes

import {
	autoUpdate,
	computePosition,
	flip,
	type Middleware,
	type Placement,
	shift,
	size,
} from "@floating-ui/dom";
import { type App, Component, type ISuggestOwner, Scope } from "obsidian";

const wrapAround = (value: number, size: number): number => {
	if (size === 0) return 0;
	return ((value % size) + size) % size;
};

class Suggest<T> {
	private owner: ISuggestOwner<T>;
	private values: T[];
	private suggestions: HTMLElement[];
	private selectedItem: number;
	private containerEl: HTMLElement;

	constructor(owner: ISuggestOwner<T>, containerEl: HTMLElement, scope: Scope) {
		this.owner = owner;
		this.containerEl = containerEl;
		this.values = [];
		this.suggestions = [];
		this.selectedItem = -1;

		containerEl.on(
			"click",
			".suggestion-item",
			this.onSuggestionClick.bind(this),
		);
		containerEl.on(
			"mousemove",
			".suggestion-item",
			this.onSuggestionMouseover.bind(this),
		);

		scope.register([], "ArrowUp", (event) => {
			if (!event.isComposing) {
				this.setSelectedItem(this.selectedItem - 1, true);
				return false;
			}
		});
		scope.register([], "ArrowDown", (event) => {
			if (!event.isComposing) {
				this.setSelectedItem(this.selectedItem + 1, true);
				return false;
			}
		});
		scope.register([], "Enter", (event) => {
			if (!event.isComposing) {
				this.useSelectedItem(event);
				return false;
			}
		});
	}

	onSuggestionClick(event: MouseEvent, el: HTMLElement): void {
		event.preventDefault();

		const item = this.suggestions.indexOf(el);
		this.setSelectedItem(item, false);
		this.useSelectedItem(event);
	}

	onSuggestionMouseover(_event: MouseEvent, el: HTMLElement): void {
		const item = this.suggestions.indexOf(el);
		this.setSelectedItem(item, false);
	}

	setSuggestions(values: T[]) {
		this.containerEl.empty();
		const suggestionEls: HTMLDivElement[] = [];

		values.forEach((value) => {
			const suggestionEl = this.containerEl.createDiv("suggestion-item");
			this.owner.renderSuggestion(value, suggestionEl);
			suggestionEls.push(suggestionEl);
		});

		this.values = values;
		this.suggestions = suggestionEls;
		this.setSelectedItem(0, false);
	}

	useSelectedItem(event: MouseEvent | KeyboardEvent) {
		const currentValue = this.values[this.selectedItem];
		if (currentValue) {
			this.owner.selectSuggestion(currentValue, event);
		}
	}

	setSelectedItem(selectedIndex: number, scrollIntoView: boolean) {
		const normalizedIndex = wrapAround(selectedIndex, this.suggestions.length);
		const prevSelectedSuggestion = this.suggestions[this.selectedItem];
		const selectedSuggestion = this.suggestions[normalizedIndex];

		prevSelectedSuggestion?.removeClass("is-selected");
		selectedSuggestion?.addClass("is-selected");

		this.selectedItem = normalizedIndex;

		if (scrollIntoView) {
			selectedSuggestion?.scrollIntoView(false);
		}
	}
}

export abstract class TextInputSuggest<T>
	extends Component
	implements ISuggestOwner<T>
{
	protected app: App;
	protected inputEl: HTMLInputElement | HTMLTextAreaElement;

	private cleanupAutoUpdate: (() => void) | undefined;
	private scope: Scope;
	private suggestEl: HTMLElement;
	private suggest: Suggest<T>;
	private isScopeActive = false;

	constructor(app: App, inputEl: HTMLInputElement | HTMLTextAreaElement) {
		super();
		this.app = app;
		this.inputEl = inputEl;
		this.scope = new Scope();

		this.suggestEl = createDiv("suggestion-container");
		const suggestion = this.suggestEl.createDiv("suggestion");
		this.suggest = new Suggest(this, suggestion, this.scope);

		this.scope.register([], "Escape", this.close.bind(this));

		// Use the Component's automatic event registration.
		// This is the entire fix. No manual binding, no manual removal.
		this.registerDomEvent(
			this.inputEl,
			"input",
			this.onInputChanged.bind(this),
		);
		this.registerDomEvent(
			this.inputEl,
			"focus",
			this.onInputChanged.bind(this),
		);
		this.registerDomEvent(this.inputEl, "blur", this.close.bind(this));
		this.registerDomEvent(this.suggestEl, "mousedown", (event: MouseEvent) => {
			event.preventDefault();
		});
	}

	// This lifecycle method is automatically called by Obsidian when the parent component unloads.
	onunload() {
		this.close();
	}

	onInputChanged(): void {
		const inputStr = this.inputEl.value;
		const suggestions = this.getSuggestions(inputStr);
		if (!suggestions) {
			this.close();
			return;
		}
		if (suggestions.length > 0) {
			this.suggest.setSuggestions(suggestions);
			this.open(this.app.workspace.containerEl, this.inputEl);
		} else {
			this.close();
		}
	}

	open(container: HTMLElement, inputEl: HTMLElement): void {
		if (!this.isScopeActive) {
			this.app.keymap.pushScope(this.scope);
			this.isScopeActive = true;
		}

		container.appendChild(this.suggestEl);
		// Use floating-ui to position the suggestion dropdown
		const placement: Placement = "bottom-start";
		const middleware: Middleware[] = [
			flip(),
			shift({ padding: 4 }),
			size({
				apply({
					rects,
					elements,
				}: {
					rects: { reference: { width: number } };
					elements: { floating: HTMLElement };
				}) {
					elements.floating.style.width = `${rects.reference.width}px`;
				},
			}),
		];
		// Ensure style baseline
		Object.assign(this.suggestEl.style, {
			position: "fixed",
			top: "0px",
			left: "0px",
			zIndex: "9999",
		});

		const update = async () => {
			const { x, y } = await computePosition(inputEl, this.suggestEl, {
				placement,
				middleware,
				strategy: "fixed",
			});
			Object.assign(this.suggestEl.style, {
				transform: `translate(${x}px, ${y}px)`,
			});
		};
		this.cleanupAutoUpdate = autoUpdate(inputEl, this.suggestEl, update);
		void update();
	}

	close(): void {
		if (this.isScopeActive) {
			this.app.keymap.popScope(this.scope);
			this.isScopeActive = false;
		}

		this.suggest.setSuggestions([]);
		if (this.cleanupAutoUpdate) {
			this.cleanupAutoUpdate();
			this.cleanupAutoUpdate = undefined;
		}
		this.suggestEl.detach();
	}

	abstract getSuggestions(inputStr: string): T[];
	abstract renderSuggestion(item: T, el: HTMLElement): void;
	abstract selectSuggestion(item: T): void;
}
