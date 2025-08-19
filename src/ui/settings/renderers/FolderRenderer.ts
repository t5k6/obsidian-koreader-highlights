import { Setting } from "obsidian";
import { toVaultPath } from "src/lib/pathing";
import type { FolderSpec, RenderCtx } from "../SettingsKit";
import type { FieldRenderer } from "../SettingsRenderer";
import { withSave } from "../SettingsRenderer";
import { FolderSuggest } from "../suggesters/FolderSuggester";

export class FolderRenderer implements FieldRenderer<FolderSpec> {
	createSetting(
		container: HTMLElement,
		spec: FolderSpec,
		ctx: RenderCtx,
	): Setting | null {
		const s = new Setting(container).setName(spec.name);
		if (spec.desc)
			s.setDesc(typeof spec.desc === "function" ? spec.desc() : spec.desc);

		s.addSearch((search) => {
			const suggester = new FolderSuggest(ctx.app, search.inputEl);
			ctx.parent.addChild(suggester);
			if (spec.placeholder) search.setPlaceholder(spec.placeholder);
			search.setValue(spec.get());
			search.inputEl.addEventListener("blur", async () => {
				const normalized = toVaultPath(search.getValue());
				search.setValue(normalized);
				await withSave(spec.set, ctx.onSave)(normalized);
			});
		});

		return s;
	}
}
