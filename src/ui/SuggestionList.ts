import { type App, Component, Scope } from "obsidian";

export interface SuggestionListConfig<T> {
	/**
	 * Container element where the list will be rendered
	 */
	containerEl: HTMLElement;

	/**
	 * Function to render each item
	 */
	renderItem: (item: T, el: HTMLElement) => void;

	/**
	 * Called when an item is selected (via click or Enter)
	 */
	onSelect: (item: T, event: MouseEvent | KeyboardEvent) => void;

	/**
	 * Optional: Custom class for the container
	 */
	containerClass?: string;

	/**
	 * Optional: Maximum visible items before scrolling
	 */
	maxVisibleItems?: number;
}

/**
 * A self-contained, reusable suggestion list component.
 * Manages its own state, rendering, and event handling.
 */
export class SuggestionList<T> extends Component {
	private items: T[] = [];
	private selectedIndex = -1;
	private itemEls: HTMLElement[] = [];
	private scope: Scope;

	constructor(
		private app: App,
		private config: SuggestionListConfig<T>,
	) {
		super();
		this.scope = new Scope();

		if (this.config.containerClass) {
			this.config.containerEl.addClass(this.config.containerClass);
		}

		this.setupEventHandlers();
	}

	/**
	 * Update the list with new items and re-render
	 */
	setItems(items: T[]): void {
		this.items = items;
		this.selectedIndex = items.length > 0 ? 0 : -1;
		this.render();
	}

	/**
	 * Clear the list and reset state
	 */
	clear(): void {
		this.items = [];
		this.selectedIndex = -1;
		this.itemEls = [];
		this.config.containerEl.empty();
	}

	/**
	 * Get the currently selected item, if any
	 */
	getSelected(): T | null {
		return this.items[this.selectedIndex] ?? null;
	}

	/**
	 * Programmatically select an item by index
	 */
	selectIndex(index: number): void {
		if (index >= 0 && index < this.items.length) {
			this.updateSelection(index, true);
		}
	}

	/**
	 * Activate this list (push keyboard scope)
	 */
	activate(): void {
		this.app.keymap.pushScope(this.scope);
	}

	/**
	 * Deactivate this list (pop keyboard scope)
	 */
	deactivate(): void {
		this.app.keymap.popScope(this.scope);
	}

	onunload(): void {
		this.clear();
		// Scope cleanup happens automatically via Component lifecycle
	}

	private setupEventHandlers(): void {
		// Keyboard navigation
		this.scope.register([], "ArrowUp", () => {
			this.moveSelection(-1);
			return false; // Prevent default
		});

		this.scope.register([], "ArrowDown", () => {
			this.moveSelection(1);
			return false;
		});

		this.scope.register([], "Enter", (evt) => {
			const selected = this.getSelected();
			if (selected) {
				this.config.onSelect(selected, evt);
			}
			return false;
		});

		// Mouse events via delegation (more efficient than per-item listeners)
		this.registerDomEvent(
			this.config.containerEl,
			"click",
			this.handleClick.bind(this),
		);

		this.registerDomEvent(
			this.config.containerEl,
			"mousemove",
			this.handleMouseMove.bind(this),
		);
	}

	private handleClick(evt: MouseEvent): void {
		const itemEl = (evt.target as HTMLElement).closest(".suggestion-item");
		if (!itemEl) return;

		const index = this.itemEls.indexOf(itemEl as HTMLElement);
		if (index >= 0) {
			const item = this.items[index];
			if (item) {
				this.config.onSelect(item, evt);
			}
		}
	}

	private handleMouseMove(evt: MouseEvent): void {
		const itemEl = (evt.target as HTMLElement).closest(".suggestion-item");
		if (!itemEl) return;

		const index = this.itemEls.indexOf(itemEl as HTMLElement);
		if (index >= 0 && index !== this.selectedIndex) {
			this.updateSelection(index, false);
		}
	}

	private render(): void {
		this.config.containerEl.empty();
		this.itemEls = [];

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const itemEl = this.config.containerEl.createDiv({
				cls: "suggestion-item",
			});

			if (i === this.selectedIndex) {
				itemEl.addClass("is-selected");
			}

			this.config.renderItem(item, itemEl);
			this.itemEls.push(itemEl);
		}

		// Apply max height if configured
		if (this.config.maxVisibleItems) {
			const firstItem = this.itemEls[0];
			if (firstItem) {
				const itemHeight = firstItem.offsetHeight;
				const maxHeight = itemHeight * this.config.maxVisibleItems;
				this.config.containerEl.style.maxHeight = `${maxHeight}px`;
				this.config.containerEl.style.overflowY = "auto";
			}
		}
	}

	private moveSelection(delta: number): void {
		if (this.items.length === 0) return;

		const newIndex = this.wrapIndex(this.selectedIndex + delta);
		this.updateSelection(newIndex, true);
	}

	private updateSelection(newIndex: number, scrollIntoView: boolean): void {
		const prevEl = this.itemEls[this.selectedIndex];
		const nextEl = this.itemEls[newIndex];

		prevEl?.removeClass("is-selected");
		nextEl?.addClass("is-selected");

		this.selectedIndex = newIndex;

		if (scrollIntoView && nextEl) {
			nextEl.scrollIntoView({ block: "nearest" });
		}
	}

	private wrapIndex(index: number): number {
		const size = this.items.length;
		if (size === 0) return -1;
		return ((index % size) + size) % size;
	}
}
