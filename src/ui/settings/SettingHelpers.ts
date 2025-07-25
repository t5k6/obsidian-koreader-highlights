import {
	type App,
	normalizePath,
	Setting,
	type TextAreaComponent,
} from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { FolderSuggest } from "src/ui/FolderSuggest";
import { pickDirectory } from "src/ui/settings/utils";
import { debounce } from "src/utils/debounce";
import { ensureFolderExists } from "src/utils/fileUtils";

export function booleanSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	get: () => boolean,
	set: (v: boolean) => void | Promise<void>,
) {
	new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addToggle((tgl) =>
			tgl.setValue(get()).onChange(async (v) => {
				await set(v);
			}),
		);
}

export function stringSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	placeholder: string,
	get: () => string,
	set: (v: string) => void | Promise<void>,
) {
	new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addText((txt) =>
			txt
				.setPlaceholder(placeholder)
				.setValue(get())
				.onChange(async (v) => {
					await set(v);
				}),
		);
}

export function dropdownSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	options: Record<string, string>,
	get: () => string,
	set: (val: string) => void | Promise<void>,
) {
	new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addDropdown((dd) => {
			for (const [k, label] of Object.entries(options)) dd.addOption(k, label);
			dd.setValue(get());
			dd.onChange(async (v) => set(v));
		});
}

export function createSetting(
	container: HTMLElement,
	name: string,
	desc: string,
): Setting {
	return new Setting(container).setName(name).setDesc(desc);
}

export interface PathSettingOpts {
	placeholder: string;
	browseLabel?: string;
	defaultPath?: string;
	requireFolder?: boolean;
	isExternal?: boolean;
}

export function pathSetting(
	container: HTMLElement,
	app: App,
	plugin: KoreaderImporterPlugin,
	name: string,
	desc: string,
	opts: PathSettingOpts,
	get: () => string,
	set: (v: string) => Promise<void> | void,
) {
	const setting = createSetting(container, name, desc);

	setting.addText((txt) => {
		txt
			.setPlaceholder(opts.placeholder)
			.setValue(get())
			.onChange(async (raw) => {
				const v = normalizePath(raw.trim() || opts.defaultPath || "");
				await set(v);
			});

		// The folder suggester is useful for all path types, so it remains.
		const suggester = new FolderSuggest(app, txt.inputEl, async (v) => {
			txt.setValue(v);
			txt.inputEl.dispatchEvent(new Event("change"));
		});

		const debouncedRefresh = debounce(
			() => suggester.refreshCache(),
			300,
			true,
		);
		plugin.registerEvent(app.vault.on("create", debouncedRefresh));
		plugin.registerEvent(app.vault.on("delete", debouncedRefresh));
		plugin.registerEvent(app.vault.on("rename", debouncedRefresh));

		if (opts.requireFolder) {
			txt.inputEl.addEventListener(
				"blur",
				debounce(async () => {
					await ensureFolderExists(app.vault, get());
				}, 750),
			);
		}
	});

	// Conditionally render the button based on the new option
	if (opts.isExternal) {
		setting.addButton((btn) =>
			btn.setButtonText(opts.browseLabel ?? "Browse…").onClick(async () => {
				const picked = await pickDirectory();
				if (picked) {
					// For mount points outside the vault, we don't use Obsidian's normalizePath
					await set(picked);
				}
			}),
		);
	}
}

export function stringArraySetting(
	container: HTMLElement,
	name: string,
	desc: string,
	get: () => string[],
	set: (value: string[]) => void | Promise<void>,
): Readonly<[Setting, TextAreaComponent]> {
	// Add Readonly for type safety
	let component: TextAreaComponent | undefined;
	const setting = new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addTextArea((text) => {
			component = text;
			text.setValue(get().join(", ")).onChange(async (value) => {
				const list = value
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
				await set(list);
			});
		});

	return [setting, component!] as const;
}
