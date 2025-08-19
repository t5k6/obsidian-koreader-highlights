import { Setting } from "obsidian";
import type { RenderCtx, ToggleSpec } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";
import { withSave } from "../SettingsRenderer";

export class ToggleRenderer implements FieldRenderer<ToggleSpec> {
	createSetting(
		container: HTMLElement,
		spec: ToggleSpec,
		ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);
		s.addToggle((tgl) =>
			tgl.setValue(spec.get()).onChange(withSave(spec.set, ctx.onSave)),
		);
		return s;
	}
}
