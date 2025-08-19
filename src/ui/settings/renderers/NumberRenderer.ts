import { Setting } from "obsidian";
import type { NumberSpec, RenderCtx } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";

export class NumberRenderer implements FieldRenderer<NumberSpec> {
	createSetting(
		container: HTMLElement,
		spec: NumberSpec,
		_ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);
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
					? Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, val))
					: fallback;
				if (String(bounded) !== raw) txt.setValue(String(bounded));
				// persist via spec.set directly (no onSave coupling defined for number here)
				await spec.set(bounded);
			});
		});
		return s;
	}
}
