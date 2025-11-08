import { Setting } from "obsidian";
import { Pathing } from "src/lib/pathing";
import type { ExternalFolderSpec, RenderCtx } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";
import { withSave } from "../SettingsRenderer";
import { attachBrowseIconButton, pickDirectory } from "../utils";

export class ExternalFolderRenderer
	implements FieldRenderer<ExternalFolderSpec>
{
	createSetting(
		container: HTMLElement,
		spec: ExternalFolderSpec,
		ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);

		s.addText((text) => {
			if (spec.placeholder) text.setPlaceholder(spec.placeholder);
			text.setValue(spec.get());
			text.inputEl.addEventListener("blur", async () => {
				const path = text.getValue().trim();
				text.setValue(path);
				await withSave(spec.set, ctx.onSave)(path);
			});
		});

		const textInput = s.controlEl.querySelector(
			"input",
		) as HTMLInputElement | null;
		if (textInput) {
			attachBrowseIconButton({
				setting: s,
				inputEl: textInput,
				icon: "folder-open",
				tooltip: "Browse…",
				onPick: () => pickDirectory(spec.browseTitle ?? "Select folder"),
				onSave: async (value: string) => {
					const normalizedDir = Pathing.normalizeSystemPath(value);
					await withSave(spec.set, ctx.onSave)(normalizedDir);
					textInput.value = normalizedDir;
				},
			});
		}

		return s;
	}
}
