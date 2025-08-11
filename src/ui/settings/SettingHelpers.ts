import { type App, type Component, Notice, Setting } from "obsidian";
import { FileSystemService } from "src/services/FileSystemService";
import { FolderSuggest } from "src/ui/settings/suggesters/FolderSuggester";
import { pickDirectory } from "src/ui/settings/utils";

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
				try {
					await set(v);
				} catch (err) {
					console.error("Failed to save boolean setting:", err);
					new Notice("Failed to save setting.");
				}
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
					try {
						await set(v);
					} catch (err) {
						console.error("Failed to save string setting:", err);
						new Notice("Failed to save setting.");
					}
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
			dd.onChange(async (v) => {
				try {
					await set(v);
				} catch (err) {
					console.error("Failed to save dropdown setting:", err);
					new Notice("Failed to save setting.");
				}
			});
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
) {
	new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addSearch((search) => {
			const suggester = new FolderSuggest(app, search.inputEl);
			parentComponent.addChild(suggester);

			search.setPlaceholder(placeholder).setValue(get());
			search.inputEl.addEventListener("blur", async () => {
				const normalized = FileSystemService.toVaultPath(search.getValue());
				search.setValue(normalized);
				try {
					await set(normalized);
				} catch (err) {
					console.error("Failed to save folder setting:", err);
					new Notice("Failed to save setting.");
				}
			});
		});
}

export function externalFolderSetting(
	container: HTMLElement,
	name: string,
	desc: string,
	placeholder: string,
	get: () => string,
	set: (path: string) => void | Promise<void>,
) {
	const setting = new Setting(container)
		.setName(name)
		.setDesc(desc)
		.addText((text) => {
			text.setPlaceholder(placeholder).setValue(get());
			text.inputEl.addEventListener("blur", async () => {
				const path = text.getValue().trim();
				text.setValue(path);
				try {
					await set(path);
				} catch (err) {
					console.error("Failed to save external folder setting (blur):", err);
					new Notice("Failed to save setting.");
				}
			});
		});
	const textInput = setting.controlEl.querySelector("input")!;
	setting.addButton((button) =>
		button
			.setIcon("folder-open")
			.setTooltip("Browse…")
			.onClick(async () => {
				const dir = await pickDirectory("Select KOReader mount point");
				if (dir) {
					const normalizedDir = FileSystemService.normalizeSystemPath(dir);
					try {
						await set(normalizedDir);
					} catch (err) {
						console.error(
							"Failed to save external folder setting (picker):",
							err,
						);
						new Notice("Failed to save setting.");
						return;
					}
					textInput.value = normalizedDir;
				}
			}),
	);
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
				try {
					await set(list);
				} catch (err) {
					console.error("Failed to save string array setting:", err);
					new Notice("Failed to save setting.");
				}
			});

			if (placeholder) {
				text.setPlaceholder(placeholder);
			}
		});
}
