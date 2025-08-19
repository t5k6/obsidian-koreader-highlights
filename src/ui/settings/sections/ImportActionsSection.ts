import type KoreaderImporterPlugin from "src/main";
import type { DebouncedFn } from "src/types";
import { runAsyncAction } from "src/ui/utils/actionUtils";
import { renderSettingsSection } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class ImportActionsSection extends SettingsSection {
	constructor(
		plugin: KoreaderImporterPlugin,
		debouncedSave: DebouncedFn,
		title: string,
		startOpen = false,
	) {
		super(plugin, debouncedSave, title, startOpen);
	}
	protected renderContent(containerEl: HTMLElement): void {
		renderSettingsSection(
			containerEl,
			[
				{
					key: "import-actions",
					type: "buttons",
					name: "Scan / Import",
					desc: "Scan for highlight files or import them into your vault.",
					buttons: [
						{
							text: "Scan Now",
							onClick: async (btn) =>
								runAsyncAction(btn, () => this.plugin.triggerScan(), {
									inProgress: "Scanning…",
									original: "Scan Now",
								}),
						},
						{
							text: "Import Now",
							cta: true,
							onClick: async (btn) =>
								runAsyncAction(btn, () => this.plugin.triggerImport(), {
									inProgress: "Importing…",
									original: "Import Now",
								}),
						},
					],
				},
			],
			{ app: this.app, parent: this },
		);
	}
}
