import {
	type App,
	ButtonComponent,
	type EventRef,
	Modal,
	type Scope,
} from "obsidian";

/**
 * Result type for modals. Each modal can define its own result shape.
 */
export type ModalResult<T> = T | null;

/**
 * Configuration for BaseModal behavior
 */
export interface BaseModalConfig {
	title?: string;
	className?: string;
	ariaLabel?: string;
	enableEscape?: boolean; // Default: true
	enableEnter?: boolean; // Default: false (modal-specific)
	focusOnOpen?: boolean; // Default: true
	preventMultipleResolve?: boolean; // Default: true
}

/**
 * Abstract base class for all promise-based modals.
 * Provides:
 * - Promise-based open pattern
 * - ARIA attributes
 * - Keyboard shortcut registration
 * - Single-resolution guarantee
 * - Focus management
 * - Cleanup handling
 */
export abstract class BaseModal<T = void> extends Modal {
	protected config: Required<BaseModalConfig>;
	protected result: ModalResult<T> = null;

	private resolvePromise: ((value: ModalResult<T>) => void) | null = null;
	private hasResolved = false;
	private shortcuts: Map<string, () => void> = new Map();
	private eventRefs: EventRef[] = [];

	constructor(app: App, config: Partial<BaseModalConfig> = {}) {
		super(app);

		// Merge with defaults
		this.config = {
			title: "",
			className: "",
			ariaLabel: config.title || "Dialog",
			enableEscape: true,
			enableEnter: false,
			focusOnOpen: true,
			preventMultipleResolve: true,
			...config,
		};
	}

	/**
	 * Opens the modal and returns a promise that resolves with the result.
	 * This is the public API that all modals should expose.
	 */
	async openAndAwaitResult(): Promise<ModalResult<T>> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.hasResolved = false;
			this.open();
		});
	}

	/**
	 * Called when the modal opens. Sets up ARIA, shortcuts, and focus.
	 * Subclasses should override renderContent() instead of onOpen().
	 */
	onOpen(): void {
		const { contentEl, titleEl } = this;

		// Clear and setup
		contentEl.empty();
		this.setupAria();

		// Add custom class if provided
		if (this.config.className) {
			contentEl.addClass(this.config.className);
		}

		// Set title if provided
		if (this.config.title) {
			titleEl.setText(this.config.title);
		}

		// Render the actual content (implemented by subclasses)
		this.renderContent(contentEl);

		// Register shortcuts after content is rendered
		this.registerShortcuts();

		// Focus management
		if (this.config.focusOnOpen) {
			this.setInitialFocus();
		}
	}

	/**
	 * Called when the modal closes. Ensures promise resolution and cleanup.
	 */
	onClose(): void {
		// Clear content
		this.contentEl.empty();

		// Unregister shortcuts
		this.unregisterShortcuts();

		// Unregister any workspace/event listeners registered via registerAppEvent
		for (const ref of this.eventRefs) {
			try {
				this.app.workspace.offref(ref);
			} catch {
				// ignore; defensive against API/version differences
			}
		}
		this.eventRefs = [];

		// Ensure promise resolves (with current result or null)
		this.resolveIfNeeded(this.result);

		// Allow subclasses to do additional cleanup
		this.onCleanup();
	}

	/**
	 * Abstract method that subclasses must implement to render their content.
	 */
	protected abstract renderContent(contentEl: HTMLElement): void;

	/**
	 * Optional cleanup hook for subclasses.
	 */
	protected onCleanup(): void {
		// Override in subclasses if needed
	}

	/**
	 * Resolves the modal with a result and closes it.
	 * This is the primary way modals should complete.
	 */
	protected resolveAndClose(result: T): void {
		this.result = result;
		this.close();
	}

	/**
	 * Cancels the modal (resolves with null) and closes it.
	 */
	protected cancel(): void {
		this.result = null;
		this.close();
	}

	/**
	 * Register a keyboard shortcut for this modal.
	 * Shortcuts are automatically cleaned up on close.
	 */
	protected registerShortcut(
		modifiers: string[],
		key: string,
		handler: () => void,
	): void {
		const id = `${modifiers.join("+")}+${key}`;

		// Prevent duplicate registration
		if (this.shortcuts.has(id)) return;

		const wrappedHandler = () => {
			// Obsidian's Scope.register typing is () => void in some versions.
			// Avoid relying on event object here for compatibility.
			// Consumers can manage preventDefault via their own DOM listeners if needed.
			handler();
		};

		this.scope.register(
			modifiers as Parameters<Scope["register"]>[0],
			key,
			wrappedHandler,
		);
		this.shortcuts.set(id, wrappedHandler);
	}

	/**
	 * Setup common shortcuts based on config.
	 * Subclasses can override to add custom shortcuts.
	 */
	protected registerShortcuts(): void {
		if (this.config.enableEscape) {
			this.registerShortcut([], "Escape", () => this.cancel());
		}

		if (this.config.enableEnter) {
			this.registerShortcut([], "Enter", () => this.handleEnter());
		}
	}

	/**
	 * Default Enter handler. Subclasses should override if enableEnter is true.
	 */
	protected handleEnter(): void {
		// Override in subclasses
		this.cancel();
	}

	/**
	 * Unregister all shortcuts (called automatically on close).
	 */
	private unregisterShortcuts(): void {
		// The scope is automatically cleaned up by Obsidian,
		// but we clear our tracking map
		this.shortcuts.clear();
	}

	/**
	 * Setup ARIA attributes for accessibility.
	 */
	private setupAria(): void {
		const { contentEl } = this;

		contentEl.setAttr("role", "dialog");
		contentEl.setAttr("aria-modal", "true");
		contentEl.setAttr("aria-label", this.config.ariaLabel);

		// Make the container focusable for keyboard nav
		if (!contentEl.hasAttribute("tabindex")) {
			contentEl.setAttr("tabindex", "-1");
		}
	}

	/**
	 * Set initial focus to the most appropriate element.
	 * Subclasses can override getFocusElement() to customize.
	 */
	private setInitialFocus(): void {
		// Allow a small delay for DOM to settle
		setTimeout(() => {
			const elementToFocus = this.getFocusElement();
			if (elementToFocus) {
				elementToFocus.focus();
			} else {
				// Fallback to the container itself
				this.contentEl.focus();
			}
		}, 50);
	}

	/**
	 * Get the element that should receive initial focus.
	 * Subclasses can override to specify a particular element.
	 */
	protected getFocusElement(): HTMLElement | null {
		// Try to find the first input, textarea, or button
		const focusable = this.contentEl.querySelector<HTMLElement>(
			'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]',
		);
		return focusable;
	}

	/**
	 * Ensures the promise resolves exactly once.
	 */
	private resolveIfNeeded(value: ModalResult<T>): void {
		if (this.config.preventMultipleResolve && this.hasResolved) {
			return;
		}

		if (this.resolvePromise) {
			this.resolvePromise(value);
			this.resolvePromise = null;
			this.hasResolved = true;
		}
	}

	/**
	 * Track an Obsidian EventRef for automatic cleanup on modal close.
	 */
	protected registerAppEvent(ref: EventRef): void {
		this.eventRefs.push(ref);
	}

	/**
	 * Create a standardized button row inside a modal.
	 * Callers supply pure button specs; this method handles DOM and styling.
	 */
	protected createButtonRow(
		parentEl: HTMLElement,
		buttons: Array<{
			text: string;
			onClick: () => void;
			cta?: boolean;
			warning?: boolean;
			disabled?: boolean;
			tooltip?: string;
		}>,
	): void {
		const container = parentEl.createDiv({ cls: "modal-button-container" });
		buttons.forEach((spec) => {
			const btn = new ButtonComponent(container)
				.setButtonText(spec.text)
				.onClick(spec.onClick);
			if (spec.cta) btn.setCta();
			if (spec.warning) btn.setWarning();
			if (spec.disabled) btn.setDisabled(true);
			if (spec.tooltip) btn.setTooltip(spec.tooltip);
		});
	}
}
