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
	render?: (contentEl: HTMLElement) => void; // Optional renderer function
}

/**
 * Base class for all promise-based modals.
 * Provides:
 * - Promise-based open pattern
 * - ARIA attributes
 * - Keyboard shortcut registration
 * - Single-resolution guarantee
 * - Focus management
 * - Cleanup handling
 */
export class BaseModal<T = void> extends Modal {
	protected config: Required<BaseModalConfig>;
	protected result: ModalResult<T> = null;

	private resolvePromise: ((value: ModalResult<T>) => void) | null = null;
	private hasResolved = false;
	private shortcuts: Map<string, () => void> = new Map();
	private eventRefs: EventRef[] = [];
	// Track lifecycle to safely support environments where Modal.open/close
	// do not invoke onOpen/onClose (e.g., test mocks), while avoiding double calls
	// in real Obsidian.
	private _isOpen = false;

	private focusTrapHandler: (event: KeyboardEvent) => void;

	constructor(app: App, config: Partial<BaseModalConfig> = {}) {
		super(app);

		// Merge with defaults, preserving optional render function
		this.config = {
			title: "",
			className: "",
			ariaLabel: config.title || "Dialog",
			enableEscape: true,
			enableEnter: false,
			focusOnOpen: true,
			preventMultipleResolve: true,
			...config,
		} as Required<BaseModalConfig>;
		this.focusTrapHandler = this.handleFocusTrap.bind(this);
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
	 * Ensure onOpen is executed once per open, even if the underlying Modal implementation
	 * does not call it (as in tests). In real Obsidian, open() already triggers onOpen;
	 * the _isOpen guard prevents double execution.
	 */
	open(): void {
		super.open();
		if (!this._isOpen) {
			this._isOpen = true;
			try {
				this.onOpen();
			} catch (error) {
				console.error("Error during modal onOpen:", error);
			}
		}
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

		this.containerEl.addEventListener("keydown", this.focusTrapHandler);

		// Render the actual content
		if (this.config.render) {
			this.config.render(contentEl);
		} else {
			this.renderContent(contentEl);
		}

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

		this.containerEl.removeEventListener("keydown", this.focusTrapHandler);

		// Allow subclasses to do additional cleanup
		this.onCleanup();
	}

	/**
	 * Mirror the open() logic to guarantee onClose runs once per close.
	 */
	close(): void {
		if (this._isOpen) {
			this._isOpen = false;
			try {
				this.onClose();
			} catch (error) {
				console.error("Error during modal onClose:", error);
			}
		}
		super.close();
	}

	/**
	 * Default render method that subclasses can override to render their content.
	 * When using the render config option, this method is not called.
	 */
	protected renderContent(contentEl: HTMLElement): void {
		// Default implementation does nothing
		// Subclasses should override this method or use the render config option
	}

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
	public resolveAndClose(result: T): void {
		this.result = result;
		this.close();
	}

	/**
	 * Cancels the modal (resolves with null) and closes it.
	 */
	public cancel(): void {
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
		// Auto-fire the primary call-to-action if one exists.
		const primaryButton = this.contentEl.querySelector<HTMLButtonElement>(
			".cta:not([disabled])",
		);
		if (primaryButton) {
			primaryButton.click();
			return;
		}
		// Fallback to cancel if no CTA is found, maintaining safe default behavior.
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
	public createButtonRow(
		parentEl: HTMLElement,
		buttons: Array<{
			text: string;
			onClick: () => void;
			icon?: string;
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

			if (spec.icon) {
				btn.setIcon(spec.icon);
				btn.buttonEl.addClass("mod-both");
			}
			if (spec.cta) btn.setCta();
			if (spec.warning) btn.setWarning();
			if (spec.disabled) btn.setDisabled(true);
			if (spec.tooltip) btn.setTooltip(spec.tooltip);
		});
	}

	/**
	 * Finds all focusable elements within the modal's content.
	 */
	private getFocusableElements(): HTMLElement[] {
		return Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="0"])',
			),
		);
	}

	/**
	 * Handles keyboard events to trap focus within the modal.
	 */
	private handleFocusTrap(event: KeyboardEvent): void {
		if (event.key !== "Tab") return;

		const focusableElements = this.getFocusableElements();
		if (focusableElements.length === 0) {
			event.preventDefault();
			return;
		}

		const firstElement = focusableElements[0];
		const lastElement = focusableElements[focusableElements.length - 1];
		const activeElement =
			this.app.workspace.activeLeaf?.view.containerEl.doc.activeElement ??
			document.activeElement;

		if (event.shiftKey) {
			// Tabbing backwards
			if (activeElement === firstElement) {
				lastElement.focus();
				event.preventDefault();
			}
		} else {
			// Tabbing forwards
			if (activeElement === lastElement) {
				firstElement.focus();
				event.preventDefault();
			}
		}
	}
}
