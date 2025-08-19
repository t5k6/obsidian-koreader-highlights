import { Setting } from "obsidian";
import type { RenderCtx, StringListSpec } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";
import { withSave } from "../SettingsRenderer";

export class StringListRenderer implements FieldRenderer<StringListSpec> {
	createSetting(
		container: HTMLElement,
		spec: StringListSpec,
		ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);

		s.addTextArea((txt) => {
			if (spec.placeholder) txt.setPlaceholder(spec.placeholder);
			txt.setValue(spec.get().join(", "));
			txt.onChange(async (raw) => {
				const list = raw
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
				await withSave(spec.set, ctx.onSave)(list);
			});
		});

		return s;
	}
}
