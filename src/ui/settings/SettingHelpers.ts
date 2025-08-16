import { type App, type Component, Notice, Setting } from "obsidian";
import { FileSystemService } from "src/services/FileSystemService";
import { FolderSuggest } from "src/ui/settings/suggesters/FolderSuggester";
import { pickDirectory } from "src/ui/settings/utils";

type SaveFn = (() => void | Promise<void>) | undefined;

/**
 * Centralized save/error handling. Wraps a setter and optionally runs onSave.
 */
function withSave<T>(set: (v: T) => void | Promise<void>, onSave?: SaveFn) {
	return async (v: T) => {
		try {
			await set(v);
			if (onSave) await onSave();
		} catch (err) {
			console.error("Failed to save setting:", err);
			new Notice("Failed to save setting.");
		}
	};
}

/* -------------------------------------------------------------------------- */
/*                    Standalone, Chainable Helpers                   */
/* -------------------------------------------------------------------------- */

export function booleanSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	get: () => boolean,
	set: (v: boolean) => void | Promise<void>,
	onSave?: SaveFn,
): Setting {
	return new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addToggle((tgl) => tgl.setValue(get()).onChange(withSave(set, onSave)));
}

export function stringSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	placeholder: string,
	get: () => string,
	set: (v: string) => void | Promise<void>,
	onSave?: SaveFn,
): Setting {
	return new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addText((txt) =>
			txt
				.setPlaceholder(placeholder)
				.setValue(get())
				.onChange(withSave(set, onSave)),
		);
}

export function numberSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	get: () => number,
	set: (v: number) => void | Promise<void>,
	opts?: { min?: number; max?: number; step?: number; onSave?: SaveFn },
): Setting {
	const { min, max, step, onSave } = opts ?? {};
	const s = new Setting(container).setName(name).setDesc(desc);
	s.addText((txt) => {
		txt.inputEl.type = "number";
		if (min != null) txt.inputEl.min = String(min);
		if (max != null) txt.inputEl.max = String(max);
		if (step != null) txt.inputEl.step = String(step);
		txt.setValue(String(get() ?? ""));
		txt.onChange(async (raw) => {
			const n = Number(raw);
			const defaultValue = get();
			const bounded = Number.isFinite(n)
				? Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n))
				: defaultValue;

			// Normalize UI if value was out-of-bounds or invalid
			if (String(bounded) !== raw) {
				txt.setValue(String(bounded));
			}

			await withSave(set, onSave)(bounded);
		});
	});
	return s;
}

export function dropdownSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	options: Record<string, string>,
	get: () => string,
	set: (val: string) => void | Promise<void>,
	onSave?: SaveFn,
): Setting {
	return new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addDropdown((dd) => {
			for (const [k, label] of Object.entries(options)) dd.addOption(k, label);
			dd.setValue(get());
			dd.onChange(withSave(set, onSave));
		});
}

export function createSetting(
	container: HTMLElement,
	name: string,
	desc: string,
): Setting {
	return new Setting(container).setName(name).setDesc(desc);
}

export function folderSetting(
	container: HTMLElement,
	parentComponent: Component,
	name: string,
	desc: string,
	placeholder: string,
	app: App,
	get: () => string,
	set: (path: string) => void | Promise<void>,
	onSave?: SaveFn,
): Setting {
	const s = new Setting(container).setName(name).setDesc(desc);
	s.addSearch((search) => {
		const suggester = new FolderSuggest(app, search.inputEl);
		parentComponent.addChild(suggester);

		search.setPlaceholder(placeholder).setValue(get());
		search.inputEl.addEventListener("blur", async () => {
			const normalized = FileSystemService.toVaultPath(search.getValue());
			search.setValue(normalized);
			await withSave(set, onSave)(normalized);
		});
	});
	return s;
}

export function externalFolderSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	placeholder: string,
	get: () => string,
	set: (path: string) => void | Promise<void>,
	onSave?: SaveFn,
): Setting {
	const setting = new Setting(container).setName(name).setDesc(desc);
	setting.addText((text) => {
		text.setPlaceholder(placeholder).setValue(get());
		text.inputEl.addEventListener("blur", async () => {
			const path = text.getValue().trim();
			text.setValue(path);
			await withSave(set, onSave)(path);
		});
	});

	const textInput = setting.controlEl.querySelector("input")!;

	setting.addButton((button) =>
		button
			.setIcon("folder-open")
			.setTooltip("Browse…")
			.onClick(async () => {
				const dir = await pickDirectory("Select KOReader folder to scan");
				if (!dir) return;
				const normalizedDir = FileSystemService.normalizeSystemPath(dir);
				await withSave(set, onSave)(normalizedDir);
				textInput.value = normalizedDir;
			}),
	);

	return setting;
}

export function stringArraySetting(
	container: HTMLElement,
	name: string,
	desc: string,
	get: () => string[],
	set: (value: string[]) => void | Promise<void>,
	placeholder?: string,
	onSave?: SaveFn,
): Setting {
	const s = new Setting(container).setName(name).setDesc(desc);
	s.addTextArea((text) => {
		text.setValue(get().join(", ")).onChange(async (value) => {
			const list = value
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean);
			await withSave(set, onSave)(list);
		});

		if (placeholder) text.setPlaceholder(placeholder);
	});
	return s;
}

/* -------------------------------------------------------------------------- */
/*                              Fluent SettingBuilder                          */
/* -------------------------------------------------------------------------- */

export class SettingBuilder {
	private readonly setting: Setting;

	constructor(
		container: HTMLElement,
		private readonly onSave?: SaveFn,
		private readonly app?: App,
		private readonly parent?: Component,
	) {
		this.setting = new Setting(container);
	}

	name(text: string): this {
		this.setting.setName(text);
		return this;
	}

	desc(text: string): this {
		this.setting.setDesc(text);
		return this;
	}

	toggle(get: () => boolean, set: (v: boolean) => void | Promise<void>): this {
		this.setting.addToggle((tgl) =>
			tgl.setValue(get()).onChange(withSave(set, this.onSave)),
		);
		return this;
	}

	text(
		get: () => string,
		set: (v: string) => void | Promise<void>,
		opts?: { placeholder?: string },
	): this {
		this.setting.addText((txt) => {
			if (opts?.placeholder) txt.setPlaceholder(opts.placeholder);
			txt.setValue(get()).onChange(withSave(set, this.onSave));
		});
		return this;
	}

	textarea(
		get: () => string,
		set: (v: string) => void | Promise<void>,
		opts?: { placeholder?: string; rows?: number; cols?: number },
	): this {
		this.setting.addTextArea((txt) => {
			if (opts?.placeholder) txt.setPlaceholder(opts.placeholder);
			if (opts?.rows) txt.inputEl.rows = opts.rows;
			if (opts?.cols) txt.inputEl.cols = opts.cols;
			txt.setValue(get()).onChange(withSave(set, this.onSave));
		});
		return this;
	}

	number(
		get: () => number,
		set: (v: number) => void | Promise<void>,
		opts?: { min?: number; max?: number; step?: number },
	): this {
		this.setting.addText((txt) => {
			txt.inputEl.type = "number";
			if (opts?.min != null) txt.inputEl.min = String(opts.min);
			if (opts?.max != null) txt.inputEl.max = String(opts.max);
			if (opts?.step != null) txt.inputEl.step = String(opts.step);
			txt.setValue(String(get()));
			txt.onChange(async (raw) => {
				const n = Number(raw);
				const defaultValue = get();
				const bounded = Number.isFinite(n)
					? Math.max(opts?.min ?? -Infinity, Math.min(opts?.max ?? Infinity, n))
					: defaultValue;

				if (String(bounded) !== raw) {
					txt.setValue(String(bounded));
				}
				await withSave(set, this.onSave)(bounded);
			});
		});
		return this;
	}

	dropdown(
		options: Record<string, string>,
		get: () => string,
		set: (v: string) => void | Promise<void>,
	): this {
		this.setting.addDropdown((dd) => {
			for (const [k, label] of Object.entries(options)) dd.addOption(k, label);
			dd.setValue(get());
			dd.onChange(withSave(set, this.onSave));
		});
		return this;
	}

	folder(
		get: () => string,
		set: (path: string) => void | Promise<void>,
		opts?: { placeholder?: string },
	): this {
		if (!this.app || !this.parent) {
			throw new Error(
				"SettingBuilder.folder requires app and parent Component",
			);
		}
		this.setting.addSearch((search) => {
			const suggester = new FolderSuggest(this.app!, search.inputEl);
			this.parent!.addChild(suggester);

			if (opts?.placeholder) search.setPlaceholder(opts.placeholder);
			search.setValue(get());
			search.inputEl.addEventListener("blur", async () => {
				const normalized = FileSystemService.toVaultPath(search.getValue());
				search.setValue(normalized);
				await withSave(set, this.onSave)(normalized);
			});
		});
		return this;
	}

	externalFolder(
		get: () => string,
		set: (path: string) => void | Promise<void>,
		opts?: { placeholder?: string; browseTitle?: string },
	): this {
		this.setting.addText((text) => {
			if (opts?.placeholder) text.setPlaceholder(opts.placeholder);
			text.setValue(get());
			text.inputEl.addEventListener("blur", async () => {
				const path = text.getValue().trim();
				text.setValue(path);
				await withSave(set, this.onSave)(path);
			});
		});
		const textInput = this.setting.controlEl.querySelector("input")!;
		this.setting.addButton((button) =>
			button
				.setIcon("folder-open")
				.setTooltip("Browse…")
				.onClick(async () => {
					const dir = await pickDirectory(opts?.browseTitle || "Select folder");
					if (!dir) return;
					const normalizedDir = FileSystemService.normalizeSystemPath(dir);
					await withSave(set, this.onSave)(normalizedDir);
					textInput.value = normalizedDir;
				}),
		);
		return this;
	}

	extraButton(config: (btn: import("obsidian").ButtonComponent) => void): this {
		this.setting.addButton(config);
		return this;
	}

	build(): Setting {
		return this.setting;
	}
}
