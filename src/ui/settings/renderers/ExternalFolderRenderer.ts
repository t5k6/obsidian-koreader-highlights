import { Setting } from "obsidian";
import { normalizeSystemPath } from "src/lib/pathing";
import type { ExternalFolderSpec, RenderCtx } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";
import { withSave } from "../SettingsRenderer";
import { pickDirectory } from "../utils";

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

		const textInput = s.controlEl.querySelector("input")!;
		s.addButton((button) =>
			button
				.setIcon("folder-open")
				.setTooltip("Browse…")
				.onClick(async () => {
					const dir = await pickDirectory(spec.browseTitle ?? "Select folder");
					if (!dir) return;
					const normalizedDir = normalizeSystemPath(dir);
					await withSave(spec.set, ctx.onSave)(normalizedDir);
					(textInput as HTMLInputElement).value = normalizedDir;
				}),
		);

		return s;
	}
}
