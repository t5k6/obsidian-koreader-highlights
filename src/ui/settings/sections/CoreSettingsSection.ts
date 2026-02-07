import { Setting } from "obsidian";
import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import { DeviceService } from "src/services/device/DeviceService";
import { SettingsSection } from "../SettingsSection";
import { attachBrowseIconButton, pickDirectory, pickFile } from "../utils";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(container: HTMLElement): void {
		// Always access plugin.settings directly to avoid stale references
		// when plugin.settings is reassigned after saves

		// --- Scan Path ---
		const scanPathSetting = new Setting(container)
			.setName("KOReader scan path")
			.setDesc(
				"Root folder to scan for KOReader .sdr directories (usually your device mount).",
			)
			.addText((text) => {
				text
					.setPlaceholder("Example: /mnt/KOReader")
					.setValue(this.plugin.settings.koreaderScanPath)
					.onChange(async (v) => {
						this.plugin.settings.koreaderScanPath = v;
						this.debouncedSave();
						// Debounced validation to avoid excessive async calls during typing
						debouncedValidatePath(v);
					});
			});

		// Live Validation Logic (Inlined)
		const validationEl = scanPathSetting.descEl.createDiv({
			cls: "koreader-setting-validation",
		});
		let validationTimeout: NodeJS.Timeout;

		const validatePath = async (path: string) => {
			if (!path) {
				validationEl.setText("");
				return;
			}
			validationEl.setText("Checking path…");
			validationEl.style.color = "var(--text-muted)";

			const deviceService = (this.plugin as any).diContainer?.resolve(
				DeviceService,
			);
			if (!deviceService) {
				validationEl.setText("❌ Unable to validate path.");
				validationEl.style.color = "var(--text-error)";
				console.error("DeviceService not available for path validation");
				return;
			}

			try {
				const result = await deviceService.validateScanPath(path);
				if (result.valid) {
					const statsMsg = result.statsDbPath ? "Stats DB found. " : "";
					const sdrMsg = result.hasSdrFolders ? ".sdr folders found." : "";
					validationEl.setText(`✅ Valid: ${statsMsg}${sdrMsg}`);
					validationEl.style.color = "var(--text-success)";
				} else {
					validationEl.setText(
						"❌ Path not found or does not contain KOReader data.",
					);
					validationEl.style.color = "var(--text-error)";
				}
			} catch (error) {
				validationEl.setText("❌ Error validating path.");
				validationEl.style.color = "var(--text-error)";
				console.error("Path validation error:", error);
			}
		};

		// Debounced version for typing, immediate for browse actions
		const debouncedValidatePath = (path: string) => {
			clearTimeout(validationTimeout);
			validationTimeout = setTimeout(() => validatePath(path), 500);
		};

		// Add browse button (using existing utility)
		attachBrowseIconButton({
			setting: scanPathSetting,
			inputEl: scanPathSetting.controlEl.querySelector(
				"input",
			) as HTMLInputElement,
			icon: "folder-open",
			tooltip: "Browse…",
			onPick: async () => pickDirectory("Select KOReader root folder"),
			onSave: async (v) => {
				this.plugin.settings.koreaderScanPath = v;
				this.debouncedSave();
				// Immediate validation for browse actions
				validatePath(v);
			},
		});

		// Initial validation
		validatePath(this.plugin.settings.koreaderScanPath);

		// --- Statistics Database Override ---
		const statsSetting = new Setting(container)
			.setName("Statistics database path override")
			.setDesc(
				"Optional: Directly specify the path to statistics.sqlite3 file. Leave empty for automatic detection.",
			)
			.addText((text) => {
				text
					.setPlaceholder("Example: /mnt/KOReader/.../statistics.sqlite3")
					.setValue(this.plugin.settings.statsDbPathOverride)
					.onChange(async (v) => {
						this.plugin.settings.statsDbPathOverride = v;
						this.debouncedSave();
					});
			});

		attachBrowseIconButton({
			setting: statsSetting,
			inputEl: statsSetting.controlEl.querySelector(
				"input",
			) as HTMLInputElement,
			icon: "folder-open",
			tooltip: "Browse…",
			onPick: () =>
				pickFile("Select KOReader statistics database", {
					filters: [
						{ name: "SQLite DB", extensions: ["sqlite3", "sqlite", "db"] },
					],
				}),
			onSave: async (v) => {
				this.plugin.settings.statsDbPathOverride = v;
				this.debouncedSave();
			},
		});

		// --- Highlights Folder ---
		// Note: Using addSearch + FolderSuggest instead of folder type
		const folderSetting = new Setting(container)
			.setName("Highlights folder")
			.setDesc("Vault folder to save highlight notes.")
			.addSearch((search) => {
				search
					.setPlaceholder(`Default: ${DEFAULT_HIGHLIGHTS_FOLDER}`)
					.setValue(this.plugin.settings.highlightsFolder);

				// Dynamic import to avoid circular dependencies if any
				import("../suggesters/FolderSuggester").then(({ FolderSuggest }) => {
					new FolderSuggest(this.app, search.inputEl, { maxVisibleItems: 20 });
				});

				search.inputEl.addEventListener("blur", async () => {
					// Normalize on blur
					const { Pathing } = await import("src/lib/pathing");
					// Get value directly from the input element to ensure we have the latest
					const rawValue = search.inputEl.value || search.getValue();
					const normalized = Pathing.toVaultPath(rawValue);
					search.setValue(normalized);
					this.plugin.settings.highlightsFolder = normalized;
					this.debouncedSave();
				});
			});

		// --- Scan Timeout ---
		new Setting(container)
			.setName("Duplicate scan timeout (seconds)")
			.setDesc(
				"Applies when the local index is not persistent. Longer time scans more files but may slow the import.",
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setValue(String(this.plugin.settings.scanTimeoutSeconds ?? 8))
					.onChange(async (v) => {
						const val = parseInt(v, 10);
						if (!Number.isNaN(val) && val > 0) {
							this.plugin.settings.scanTimeoutSeconds = val;
							this.debouncedSave();
						}
					});
			});
	}
}
