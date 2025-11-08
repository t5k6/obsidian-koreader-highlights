import { Notice, type Setting, setIcon } from "obsidian";
import { ButtonsRenderer } from "src/ui/settings/renderers/ButtonsRenderer";
import { CustomRenderer } from "src/ui/settings/renderers/CustomRenderer";
import { DropdownRenderer } from "src/ui/settings/renderers/DropdownRenderer";
import { ExternalFolderRenderer } from "src/ui/settings/renderers/ExternalFolderRenderer";
import { FolderRenderer } from "src/ui/settings/renderers/FolderRenderer";
import { NumberRenderer } from "src/ui/settings/renderers/NumberRenderer";
import { StringListRenderer } from "src/ui/settings/renderers/StringListRenderer";
import { TextRenderer } from "src/ui/settings/renderers/TextRenderer";
import { ToggleRenderer } from "src/ui/settings/renderers/ToggleRenderer";
import type {
	BaseSpec,
	CalloutSpec,
	GroupSpec,
	HeaderSpec,
	RenderCtx,
	RowAction,
	SettingSpec,
} from "./SettingsKit";

export interface FieldRenderer<T extends BaseSpec> {
	createSetting(
		container: HTMLElement,
		spec: T,
		ctx: RenderCtx,
	): Setting | null;
}

export class SettingsRenderer {
	private fieldRenderers: Map<string, FieldRenderer<any>>;

	constructor(private ctx: RenderCtx) {
		this.fieldRenderers = this.initFieldRenderers();
	}

	render(container: HTMLElement, specs: SettingSpec[]): Setting[] {
		const settings: Setting[] = [];

		for (const spec of specs) {
			// Structural types
			if (spec.type === "group") {
				const gs = spec as GroupSpec;
				if (gs.if && !gs.if()) continue;
				const el = container.createDiv({
					cls: gs.className ?? "koreader-settings-group",
				});
				if (gs.header)
					el.createEl(`h${gs.header.level ?? 4}` as any, {
						text: gs.header.text,
					});
				this.render(el, gs.children);
				continue;
			}

			if (spec.type === "header") {
				const hs = spec as HeaderSpec;
				const level = hs.level ?? 3;
				container.createEl(`h${level}` as any, { text: hs.text });
				continue;
			}

			if (spec.type === "callout") {
				const cs = spec as CalloutSpec;
				if (cs.if && !cs.if()) continue;

				const callout = container.createDiv({
					cls: "callout",
				}) as any;
				// In app, Obsidian elements expose setAttr; in tests our obsidian.mock adds it.
				// Be defensive so plain HTMLElements won't crash.
				const setAttr =
					typeof callout.setAttr === "function"
						? (k: string, v: string) => callout.setAttr(k, v)
						: (k: string, v: string) => callout.setAttribute(k, v);

				setAttr("data-callout", cs.calloutType);
				if (cs.id) setAttr("id", cs.id);

				const titleEl = callout.createDiv({ cls: "callout-title" });
				const iconEl = titleEl.createDiv({ cls: "callout-icon" });
				setIcon(iconEl, this.iconForCallout(cs.calloutType));
				titleEl.createDiv({ cls: "callout-title-inner", text: cs.title });
				callout.createDiv({ cls: "callout-content", text: cs.text });
				continue;
			}

			// BaseSpec-gated visibility
			if ((spec as any).if && !(spec as any).if()) continue;

			const renderer = this.fieldRenderers.get(spec.type);
			if (!renderer) continue;

			const setting = renderer.createSetting(container, spec as any, this.ctx);
			if (!setting) continue;

			this.applyCommonBehaviors(setting, spec as any);
			settings.push(setting);
		}

		return settings;
	}

	private initFieldRenderers(): Map<string, FieldRenderer<any>> {
		return new Map<string, FieldRenderer<any>>([
			["toggle", new ToggleRenderer()],
			["text", new TextRenderer()],
			["number", new NumberRenderer()],
			["dropdown", new DropdownRenderer()],
			["folder", new FolderRenderer()],
			["external-folder", new ExternalFolderRenderer()],
			["string-list", new StringListRenderer()],
			["buttons", new ButtonsRenderer()],
			["custom", new CustomRenderer()],
		]);
	}

	private iconForCallout(t: CalloutSpec["calloutType"]): string {
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

	private applyCommonBehaviors(setting: Setting, spec: BaseSpec): void {
		// tooltip on name
		if (spec.tooltip) {
			setting.nameEl?.setAttr?.("title", spec.tooltip);
		}

		// row actions
		if (spec.rowActions?.length) {
			for (const a of spec.rowActions as RowAction[]) {
				setting.addButton((btn) => {
					if (a.icon) btn.setIcon(a.icon);
					btn.setButtonText(a.text).onClick(() => a.onClick(btn));
					if (a.cta) btn.setCta();
					if (a.warning) btn.setWarning();
					if (a.tooltip) btn.setTooltip(a.tooltip);
					const disabled =
						typeof a.disabled === "function" ? a.disabled() : a.disabled;
					if (disabled) btn.setDisabled(true);
				});
			}
		}

		// disabled row
		const isDisabled =
			typeof spec.disabled === "function" ? spec.disabled() : spec.disabled;
		if (isDisabled) {
			setting.settingEl.addClass("is-disabled");
			setting.controlEl
				.querySelectorAll<HTMLElement>("input, select, textarea, button")
				.forEach((el) => {
					(el as any).disabled = true;
				});
		}

		// after render hook
		spec.afterRender?.(setting);
	}
}

// shared util for renderers
export const withSave =
	<T>(set: (v: T) => void | Promise<void>, onSave?: RenderCtx["onSave"]) =>
	async (v: T) => {
		try {
			await set(v);
			if (onSave) await onSave();
		} catch (err) {
			console.error("Failed to save setting:", err);
			new Notice("Failed to save setting.");
		}
	};
