import { type App, Notice, Setting } from "obsidian";
import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { FolderSuggest } from "src/ui/FolderSuggest";
import { pickDirectory } from "src/ui/settings/utils";
import { toVaultRelPath } from "src/utils/fileUtils";

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
	cfg: {
		label: string;
		desc: string;
		get: () => string;
		setAndSave: (v: string) => Promise<void>;
		requireFolder?: boolean;
		isExternal?: boolean;
	},
) {
	const setting = new Setting(container).setName(cfg.label).setDesc(cfg.desc);

	setting.addText((t) => {
		const val = cfg.get() || DEFAULT_HIGHLIGHTS_FOLDER;
		t.setValue(val);
		t.inputEl.style.width = "100%";

		t.inputEl.addEventListener("blur", async () => {
			let v = cfg.isExternal
				? t.getValue().trim()
				: toVaultRelPath(t.getValue());

			if (!cfg.isExternal) {
				v = v.toLowerCase();
			}

			if (!v && !cfg.requireFolder) {
				await cfg.setAndSave("");
				return;
			}

			if (!v) v = DEFAULT_HIGHLIGHTS_FOLDER;

			if (cfg.requireFolder && v && !app.vault.getFolderByPath(v)) {
				await app.vault.createFolder(v).catch((e) => {
					new Notice("Could not create folder – see console.", 6000);
					console.error(e);
				});
			}

			await cfg.setAndSave(v);
			t.setValue(v);
		});
	});

	// --- Suggestions ---
	const textInput = setting.controlEl.querySelector("input")!;
	new FolderSuggest(app, plugin, textInput, (s) => {
		textInput.value = s;
		textInput.dispatchEvent(new Event("blur"));
	});

	// --- Optional external picker ---
	if (cfg.isExternal) {
		setting.addButton((b) =>
			b
				.setIcon("folder-open")
				.setTooltip("Browse…")
				.onClick(async () => {
					const dir = await pickDirectory();
					if (dir) {
						await cfg.setAndSave(dir);
						textInput.value = dir;
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
	placeholder?: string,
): void {
	new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addTextArea((text) => {
			text.setValue(get().join(", ")).onChange(async (value) => {
				const list = value
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
				await set(list);
			});

			if (placeholder) {
				text.setPlaceholder(placeholder);
			}
		});
}
