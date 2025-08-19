import { Setting } from "obsidian";
import type { DropdownSpec, RenderCtx } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";
import { withSave } from "../SettingsRenderer";

export class DropdownRenderer implements FieldRenderer<DropdownSpec> {
	createSetting(
		container: HTMLElement,
		spec: DropdownSpec,
		ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);
		s.addDropdown((dd) => {
			const opts =
				typeof spec.options === "function" ? spec.options() : spec.options;
			for (const k in opts) dd.addOption(k, opts[k]!);
			dd.setValue(spec.get());
			dd.onChange(withSave(spec.set, ctx.onSave));
		});
		return s;
	}
}
