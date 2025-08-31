import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import { DeviceService } from "src/services/device/DeviceService";
import { renderSettingsSection } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(container: HTMLElement): void {
		renderSettingsSection(
			container,
			[
				{
					key: "scanPath",
					type: "external-folder",
					name: "KOReader scan path",
					desc: "Root folder to scan for KOReader .sdr directories (usually your device mount).",
					placeholder: "Example: /mnt/KOReader",
					get: () => this.plugin.settings.koreaderScanPath,
					set: (v) => {
						this.plugin.settings.koreaderScanPath = v;
					},
					// Add live validation feedback
					afterRender: (setting) => {
						const feedbackEl = setting.descEl.createDiv({
							cls: "koreader-setting-validation",
						});
						const inputEl = setting.controlEl.querySelector("input");

						const validate = async (path: string) => {
							if (!path) {
								feedbackEl.setText("");
								return;
							}

							feedbackEl.setText("Checking path…");
							// Access DeviceService through the plugin's DI container
							const deviceService = (this.plugin as any).diContainer?.resolve(
								DeviceService,
							);
							if (!deviceService) {
								feedbackEl.setText("❌ Unable to validate path.");
								feedbackEl.style.color = "var(--text-error)";
								return;
							}
							const result = await deviceService.validateScanPath(path);

							if (result.valid) {
								const statsMsg = result.statsDbPath ? "Stats DB found. " : "";
								const sdrMsg = result.hasSdrFolders
									? ".sdr folders found."
									: "";
								feedbackEl.setText(`✅ Valid: ${statsMsg}${sdrMsg}`);
								feedbackEl.style.color = "var(--text-success)";
							} else {
								feedbackEl.setText(
									"❌ Path not found or does not contain KOReader data.",
								);
								feedbackEl.style.color = "var(--text-error)";
							}
						};

						inputEl?.addEventListener("change", (e) =>
							validate((e.target as HTMLInputElement).value),
						);
						validate(this.plugin.settings.koreaderScanPath); // Initial validation
					},
				},
				{
					key: "highlightsFolder",
					type: "folder",
					name: "Highlights folder",
					desc: "Vault folder to save highlight notes.",
					placeholder: `Default: ${DEFAULT_HIGHLIGHTS_FOLDER}`,
					get: () => this.plugin.settings.highlightsFolder,
					set: (v) => {
						this.plugin.settings.highlightsFolder = v;
					},
				},
				{
					key: "scanTimeoutSeconds",
					type: "number",
					name: "Duplicate scan timeout (seconds)",
					desc: "Applies when the local index is not persistent. Longer time scans more files but may slow the import.",
					min: 1,
					step: 1,
					get: () => this.plugin.settings.scanTimeoutSeconds ?? 8,
					set: (v) => {
						this.plugin.settings.scanTimeoutSeconds = v;
					},
				},
			],
			{ app: this.app, parent: this, onSave: this.debouncedSave },
		);
	}
}
