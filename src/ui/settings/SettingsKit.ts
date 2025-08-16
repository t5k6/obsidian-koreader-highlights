import { type App, type Component, Notice, Setting, setIcon } from "obsidian";
import { FileSystemService } from "src/services/FileSystemService";
import { FolderSuggest } from "./suggesters/FolderSuggester";
import { pickDirectory } from "./utils";

type SaveFn = (() => void | Promise<void>) | undefined;

export interface RenderCtx {
	app: App;
	parent: Component;
	onSave?: SaveFn;
}

type BaseSpec = {
	key: string;
	name: string;
	desc?: string;
	if?: () => boolean;
	afterRender?: (setting: Setting) => void;
	disabled?: boolean | (() => boolean);
	tooltip?: string;
};

export type ToggleSpec = BaseSpec & {
	type: "toggle";
	get: () => boolean;
	set: (v: boolean) => void | Promise<void>;
};

export type TextSpec = BaseSpec & {
	type: "text";
	placeholder?: string;
	get: () => string;
	set: (v: string) => void | Promise<void>;
};

export type NumberSpec = BaseSpec & {
	type: "number";
	min?: number;
	max?: number;
	step?: number;
	get: () => number;
	set: (v: number) => void | Promise<void>;
};

export type DropdownSpec = BaseSpec & {
	type: "dropdown";
	options: Record<string, string> | (() => Record<string, string>);
	get: () => string;
	set: (v: string) => void | Promise<void>;
};

export type FolderSpec = BaseSpec & {
	type: "folder";
	placeholder?: string;
	get: () => string;
	set: (path: string) => void | Promise<void>;
};

export type ExternalFolderSpec = BaseSpec & {
	type: "external-folder";
	placeholder?: string;
	browseTitle?: string;
	get: () => string;
	set: (path: string) => void | Promise<void>;
};

export type StringListSpec = BaseSpec & {
	type: "string-list";
	placeholder?: string;
	get: () => string[];
	set: (value: string[]) => void | Promise<void>;
};

export type HeaderSpec = {
	type: "header";
	text: string;
	level?: 2 | 3 | 4; // default 3
};

export type CalloutSpec = {
	type: "callout";
	id: string; // unique within the section container
	calloutType: "warning" | "info" | "error" | "tip";
	title: string;
	text: string;
	if?: () => boolean;
};

export type ButtonDef = {
	text: string;
	cta?: boolean;
	warning?: boolean;
	icon?: string;
	tooltip?: string;
	disabled?: boolean | (() => boolean);
	onClick: (btn: import("obsidian").ButtonComponent) => void | Promise<void>;
};

export type ButtonsSpec = BaseSpec & {
	type: "buttons";
	buttons: ButtonDef[];
};

export type CustomSpec = BaseSpec & {
	type: "custom";
	render: (setting: Setting, ctx: RenderCtx) => void;
};

export type SettingSpec =
	| ToggleSpec
	| TextSpec
	| NumberSpec
	| DropdownSpec
	| FolderSpec
	| ExternalFolderSpec
	| StringListSpec
	| ButtonsSpec
	| CustomSpec
	| HeaderSpec
	| CalloutSpec;

// Helper to map callout type to an icon name
function iconForCallout(t: CalloutSpec["calloutType"]): string {
	switch (t) {
		case "warning":
			return "alert-triangle";
		case "error":
			return "alert-circle";
		case "info":
			return "info";
		case "tip":
			return "lightbulb";
	}
}

const withSave =
	<T>(set: (v: T) => void | Promise<void>, onSave?: SaveFn) =>
	async (v: T) => {
		try {
			await set(v);
			if (onSave) await onSave();
		} catch (err) {
			console.error("Failed to save setting:", err);
			new Notice("Failed to save setting.");
		}
	};

export function renderSettingsSection(
	container: HTMLElement,
	specs: SettingSpec[],
	ctx: RenderCtx,
): Setting[] {
	const created: Setting[] = [];

	for (const spec of specs) {
		// Headers are lightweight and have no BaseSpec props
		if (spec.type === "header") {
			const hs = spec as HeaderSpec;
			const level = hs.level ?? 3;
			container.createEl(
				`h${level}` as unknown as keyof HTMLElementTagNameMap,
				{
					text: hs.text,
				},
			);
			continue;
		}

		// New: callout is a standalone block (not a Setting row)
		if (spec.type === "callout") {
			const cs = spec as CalloutSpec;
			if (cs.if && !cs.if()) continue;

			const callout = container.createDiv({
				cls: "callout",
				attr: { "data-callout": cs.calloutType, id: cs.id },
			});

			const titleEl = callout.createDiv({ cls: "callout-title" });
			const iconEl = titleEl.createDiv({ cls: "callout-icon" });
			setIcon(iconEl, iconForCallout(cs.calloutType));
			titleEl.createDiv({ cls: "callout-title-inner", text: cs.title });

			callout.createDiv({ cls: "callout-content", text: cs.text });
			continue;
		}

		// Guard for BaseSpec-based rows
		if ((spec as any).if && !(spec as any).if()) continue;

		const s = new Setting(container);
		if ((spec as any).name) s.setName((spec as any).name as string);
		if ((spec as any).desc) s.setDesc((spec as any).desc as string);

		switch (spec.type) {
			case "toggle": {
				s.addToggle((tgl) =>
					tgl.setValue(spec.get()).onChange(withSave(spec.set, ctx.onSave)),
				);
				break;
			}
			case "text": {
				s.addText((txt) => {
					if (spec.placeholder) txt.setPlaceholder(spec.placeholder);
					txt.setValue(spec.get()).onChange(withSave(spec.set, ctx.onSave));
				});
				break;
			}
			case "number": {
				s.addText((txt) => {
					txt.inputEl.type = "number";
					if (spec.min != null) txt.inputEl.min = String(spec.min);
					if (spec.max != null) txt.inputEl.max = String(spec.max);
					if (spec.step != null) txt.inputEl.step = String(spec.step);
					txt.setValue(String(spec.get()));
					txt.onChange(async (raw) => {
						const val = Number(raw);
						const fallback = spec.get();
						const bounded = Number.isFinite(val)
							? Math.max(
									spec.min ?? -Infinity,
									Math.min(spec.max ?? Infinity, val),
								)
							: fallback;
						if (String(bounded) !== raw) txt.setValue(String(bounded));
						await withSave(spec.set, ctx.onSave)(bounded);
					});
				});
				break;
			}
			case "dropdown": {
				const sp = spec as DropdownSpec;
				s.addDropdown((dd) => {
					const opts: Record<string, string> =
						typeof sp.options === "function"
							? (sp.options as () => Record<string, string>)()
							: sp.options;
					for (const k in opts) {
						dd.addOption(k, opts[k]!);
					}
					dd.setValue(sp.get());
					dd.onChange(withSave(sp.set, ctx.onSave));
				});
				break;
			}
			case "folder": {
				s.addSearch((search) => {
					const suggester = new FolderSuggest(ctx.app, search.inputEl);
					ctx.parent.addChild(suggester);
					if (spec.placeholder) search.setPlaceholder(spec.placeholder);
					search.setValue(spec.get());
					search.inputEl.addEventListener("blur", async () => {
						const normalized = FileSystemService.toVaultPath(search.getValue());
						search.setValue(normalized);
						await withSave(spec.set, ctx.onSave)(normalized);
					});
				});
				break;
			}
			case "external-folder": {
				s.addText((text) => {
					if (spec.placeholder) text.setPlaceholder(spec.placeholder);
					text.setValue(spec.get());
					text.inputEl.addEventListener("blur", async () => {
						const path = text.getValue().trim();
						text.setValue(path);
						await withSave(spec.set, ctx.onSave)(path);
					});
				});
				const textInput = s.controlEl.querySelector("input")!;
				s.addButton((button) =>
					button
						.setIcon("folder-open")
						.setTooltip("Browse…")
						.onClick(async () => {
							const dir = await pickDirectory(
								(spec as any).browseTitle ?? "Select folder",
							);
							if (!dir) return;
							const normalizedDir = FileSystemService.normalizeSystemPath(dir);
							await withSave((spec as any).set, ctx.onSave)(normalizedDir);
							textInput.value = normalizedDir;
						}),
				);
				break;
			}
			case "string-list": {
				s.addTextArea((txt) => {
					if ((spec as any).placeholder)
						txt.setPlaceholder((spec as any).placeholder);
					txt.setValue((spec as any).get().join(", "));
					txt.onChange(async (raw) => {
						const list = raw
							.split(",")
							.map((v) => v.trim())
							.filter(Boolean);
						await withSave((spec as any).set, ctx.onSave)(list);
					});
				});
				break;
			}
			case "buttons": {
				const bs = spec as ButtonsSpec;
				for (const b of bs.buttons) {
					s.addButton((btn) => {
						if (b.icon) btn.setIcon(b.icon);
						btn.setButtonText(b.text).onClick(() => b.onClick(btn));
						if (b.cta) btn.setCta();
						if (b.warning) btn.setWarning();
						if (b.tooltip) btn.setTooltip(b.tooltip);
						const d =
							typeof b.disabled === "function" ? b.disabled() : b.disabled;
						if (d) btn.setDisabled(true);
					});
				}
				break;
			}
			case "custom": {
				const cs = spec as CustomSpec;
				cs.render(s, ctx);
				break;
			}
		}

		// Apply tiny ergonomic bumps (BaseSpec only)
		if ((spec as any).tooltip) {
			(s.nameEl as HTMLElement | undefined)?.setAttr?.(
				"title",
				(spec as any).tooltip as string,
			);
		}

		const isDisabled =
			typeof (spec as any).disabled === "function"
				? (spec as any).disabled()
				: (spec as any).disabled;
		if (isDisabled) {
			s.settingEl.addClass("is-disabled");
			s.controlEl
				.querySelectorAll<HTMLElement>("input, select, textarea, button")
				.forEach((el) => {
					(el as any).disabled = true;
				});
		}

		(spec as any).afterRender?.(s);
		created.push(s);
	}

	return created;
}
