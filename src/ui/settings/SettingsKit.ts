import type { App, Component, Setting } from "obsidian";
import { SettingsRenderer } from "./SettingsRenderer";

type SaveFn = (() => void | Promise<void>) | undefined;

export interface RenderCtx {
	app: App;
	parent: Component;
	onSave?: SaveFn;
}

export type RowAction = {
	text: string;
	icon?: string;
	cta?: boolean;
	warning?: boolean;
	tooltip?: string;
	disabled?: boolean | (() => boolean);
	onClick: (btn: import("obsidian").ButtonComponent) => void | Promise<void>;
};

export type BaseSpec = {
	key: string;
	name: string;
	desc?: string | (() => string);
	if?: () => boolean;
	afterRender?: (setting: Setting) => void;
	disabled?: boolean | (() => boolean);
	tooltip?: string;
	rowActions?: RowAction[];
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

export type GroupSpec = {
	type: "group";
	if?: () => boolean;
	header?: { text: string; level?: 2 | 3 | 4 };
	className?: string;
	children: SettingSpec[];
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
	| CalloutSpec
	| GroupSpec;

export function renderSettingsSection(
	container: HTMLElement,
	specs: SettingSpec[],
	ctx: RenderCtx,
): Setting[] {
	return new SettingsRenderer(ctx).render(container, specs);
}
