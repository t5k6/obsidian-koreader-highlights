import {
	autoUpdate,
	computePosition,
	flip,
	type Middleware,
	type Placement,
	shift,
	size,
} from "@floating-ui/dom";
import { type App, Component, Scope } from "obsidian";
import { SuggestionList } from "src/ui/SuggestionList";

export abstract class TextInputSuggest<T> extends Component {
	protected app: App;
	protected inputEl: HTMLInputElement | HTMLTextAreaElement;

	private cleanupAutoUpdate: (() => void) | undefined;
	private scope: Scope;
	private suggestEl: HTMLElement;
	private listEl: HTMLElement;
	private suggestionList: SuggestionList<T>;
	private isScopeActive = false;

	constructor(app: App, inputEl: HTMLInputElement | HTMLTextAreaElement) {
		super();
		this.app = app;
		this.inputEl = inputEl;
		this.scope = new Scope();

		this.suggestEl = createDiv("suggestion-container");
		this.listEl = this.suggestEl.createDiv("suggestion");

		this.suggestionList = new SuggestionList<T>(this.app, {
			containerEl: this.listEl,
			renderItem: (item, el) => this.renderItem(item, el),
			onSelect: (item, _evt) => {
				this.selectSuggestion(item);
				this.close();
			},
			maxVisibleItems: 10,
		});

		// Ensure child lifecycle cleanup
		this.addChild(this.suggestionList);

		this.scope.register([], "Escape", this.close.bind(this));

		// Automatic event registration
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
			// Prevent input blur when clicking suggestions
			event.preventDefault();
		});
	}

	onunload(): void {
		this.close();
	}

	private onInputChanged(): void {
		const inputStr = this.inputEl.value ?? "";
		const suggestions = this.getSuggestions(inputStr);
		if (!suggestions || suggestions.length === 0) {
			this.close();
			return;
		}
		this.suggestionList.setItems(suggestions);
		this.open(this.app.workspace.containerEl, this.inputEl);
	}

	private open(container: HTMLElement, inputEl: HTMLElement): void {
		if (!this.isScopeActive) {
			this.app.keymap.pushScope(this.scope);
			this.isScopeActive = true;
		}

		container.appendChild(this.suggestEl);

		// Position the suggestion dropdown using floating-ui
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
		this.suggestionList.activate();
	}

	private close(): void {
		if (this.isScopeActive) {
			this.app.keymap.popScope(this.scope);
			this.isScopeActive = false;
		}

		this.suggestionList.clear();
		this.suggestionList.deactivate();
		if (this.cleanupAutoUpdate) {
			this.cleanupAutoUpdate();
			this.cleanupAutoUpdate = undefined;
		}
		this.suggestEl.detach();
	}

	// Abstract API for consumers
	protected abstract getSuggestions(inputStr: string): T[];
	protected abstract renderItem(item: T, el: HTMLElement): void;
	protected abstract selectSuggestion(item: T): void;
}
