import { Setting } from "obsidian";
import type { CustomSpec, RenderCtx } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";

export class CustomRenderer implements FieldRenderer<CustomSpec> {
	createSetting(
		container: HTMLElement,
		spec: CustomSpec,
		ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);
		spec.render(s, ctx);
		return s;
	}
}
