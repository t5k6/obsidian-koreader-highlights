import { Setting } from "obsidian";
import type { ButtonDef, ButtonsSpec, RenderCtx } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";

export class ButtonsRenderer implements FieldRenderer<ButtonsSpec> {
	createSetting(
		container: HTMLElement,
		spec: ButtonsSpec,
		_ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);

		for (const b of spec.buttons as ButtonDef[]) {
			s.addButton((btn) => {
				if (b.icon) btn.setIcon(b.icon);
				btn.setButtonText(b.text).onClick(() => b.onClick(btn));
				if (b.cta) btn.setCta();
				if (b.warning) btn.setWarning();
				if (b.tooltip) btn.setTooltip(b.tooltip);
				const d = typeof b.disabled === "function" ? b.disabled() : b.disabled;
				if (d) btn.setDisabled(true);
			});
		}

		return s;
	}
}
