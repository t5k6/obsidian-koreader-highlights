import { Setting } from "obsidian";
import type { RenderCtx, TextSpec } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";
import { withSave } from "../SettingsRenderer";

export class TextRenderer implements FieldRenderer<TextSpec> {
	createSetting(
		container: HTMLElement,
		spec: TextSpec,
		ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);
		s.addText((txt) => {
			if (spec.placeholder) txt.setPlaceholder(spec.placeholder);
			txt.setValue(spec.get()).onChange(withSave(spec.set, ctx.onSave));
		});
		return s;
	}
}
