// Local module used via Vitest alias to replace "obsidian" imports during tests.

export class Modal {
	app: unknown;
	containerEl: { createEl: (tag: string, opts?: unknown) => unknown };
	constructor(app?: unknown) {
		this.app = app;
		this.containerEl = { createEl: (_tag: string, _opts?: unknown) => ({}) };
	}
	open() {}
	close() {}
}

export class ButtonComponent {
	buttonEl: { innerText: string };
	constructor() {
		this.buttonEl = { innerText: "" };
	}
	setDisabled(_disabled: boolean) {}
	setButtonText(text: string) {
		this.buttonEl.innerText = text;
	}
}

// Minimal App/Component/Scope surface needed by UI suggesters and code under test
export class Scope {
	private handlers: Array<() => void> = [];
	register(_mods: string[], _key: string, _cb: (e: unknown) => unknown) {
		this.handlers.push(() => {});
	}
}

// NOTE: Component must be defined only once
export class Component {
	private domUnsub: Array<() => void> = [];
	registerDomEvent(el: HTMLElement, evt: string, handler: EventListener) {
		el.addEventListener(evt, handler);
		this.domUnsub.push(() => el.removeEventListener(evt, handler));
	}
	onunload() {
		this.domUnsub.forEach((fn) => {
			fn();
		});
		this.domUnsub = [];
	}
}

export class App {
	keymap = {
		stack: [] as Scope[],
		pushScope: (s: Scope) => this.keymap.stack.push(s),
		popScope: (_s: Scope) => {
			this.keymap.stack.pop();
		},
	};
	workspace = { containerEl: (globalThis as any).document?.body ?? {} };
	vault = {
		getAllLoadedFiles: () => [] as unknown[],
		on: (_evt: string, _cb: (...args: unknown[]) => unknown) => () => {},
	};
}

export class Notice {
	constructor(_msg: string) {}
}

/**
 * Mirror of Obsidian's normalizePath for tests: convert backslashes to slashes,
 * collapse duplicate slashes, trim, and remove trailing slash except for root.
 */
export function normalizePath(p: string): string {
	if (p == null) return "";
	let s = String(p).trim().replace(/\\/g, "/");
	s = s.replace(/\/{2,}/g, "/");
	if (s.length > 1) s = s.replace(/\/+$/, "");
	return s;
}

// Minimal file item classes used by services
export class TAbstractFile {
	path = "";
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

// Helpers used by services
export function debounce<T extends (...args: unknown[]) => unknown>(
	fn: T,
	wait: number,
	immediate = false,
): T & { cancel: () => void } {
	let timeout: ReturnType<typeof setTimeout> | null = null;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		const later = () => {
			timeout = null;
			if (!immediate) (fn as any).apply(this, args);
		};
		const callNow = immediate && !timeout;
		if (timeout) clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) (fn as any).apply(this, args);
	} as unknown as T & { cancel: () => void };
	(wrapped as any).cancel = () => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = null;
		}
	};
	return wrapped;
}

export class Plugin {
	app: App;
	manifest: any;
	constructor(app: App, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}

	// Add stubs for methods called on the plugin instance
	addSettingTab(tab: PluginSettingTab) {
		// No-op for tests
	}

	addCommand(command: any) {
		// No-op for tests
	}

	registerEvent(eventRef: any) {
		// No-op for tests
	}

	async loadData() {
		return {};
	}
	async saveData(data: any) {}
}

// This is the missing mock that caused the test failure.
export class PluginSettingTab {
	app: App;
	plugin: Plugin;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}

	display(): void {
		// Mock implementation, does nothing.
	}

	hide(): void {
		// Mock implementation, does nothing. `SettingsTab` calls `super.hide()`.
	}
}
