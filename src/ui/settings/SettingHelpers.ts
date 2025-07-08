import { Setting, type TextAreaComponent } from "obsidian";

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

export function stringArraySetting(
	container: HTMLElement,
	name: string,
	desc: string,
	get: () => string[],
	set: (value: string[]) => void | Promise<void>,
): [Setting, TextAreaComponent] {
	let component: TextAreaComponent;
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

	return [setting, component!];
}
