import type { Plugin } from "obsidian";
import type {
	FrontmatterSettings,
	KoreaderHighlightImporterSettings,
	KoreaderTemplateSettings,
} from "../types";
import { devError, devLog, devWarn } from "../utils/logging";

export const DEFAULT_SETTINGS: KoreaderHighlightImporterSettings = {
	koboMountPoint: "",
	excludedFolders: [
		".adds",
		".kobo",
		"$RECYCLE.BIN",
		"System Volume Information",
		".git",
		".obsidian",
		".stfolder",
		".stversions",
	],
	allowedFileTypes: ["epub", "pdf", "mobi", "cbz"],
	highlightsFolder: "KOReader/highlights",
	debugMode: false,
	debugLevel: 3,
	enableFullDuplicateCheck: false,
	frontmatter: {
		disabledFields: [],
		customFields: [],
	},
	maxHighlightGap: 5,
	maxTimeGapMinutes: 10,
	mergeOverlappingHighlights: true,
	template: {
		useCustomTemplate: false,
		source: "vault",
		selectedTemplate: "default",
		templateDir: "KOReader/templates",
	},
};

export class PluginSettings {
	constructor(private plugin: Plugin) {}

	private validateType<T>(
		obj: any,
		key: string,
		expectedType: string,
		defaultValue: T,
		customMessage?: string,
	): T {
		if (typeof obj[key] !== expectedType) {
			devWarn(
				customMessage ||
					`Correcting invalid '${key}' (was ${typeof obj[
						key
					]}). Resetting to default.`,
			);
			return defaultValue;
		}
		return obj[key];
	}

	private validateEnum<T extends number | string>(
		obj: any,
		key: string,
		allowedValues: readonly T[] | T[],
		defaultValue: T,
		customMessage?: string,
	): T {
		if (!allowedValues.includes(obj[key] as T)) {
			devWarn(
				customMessage ||
					`Correcting invalid '${key}' (${
						obj[key]
					}). Resetting to default (${defaultValue}).`,
			);
			return defaultValue;
		}
		return obj[key] as T;
	}

	private validateStringArray(
		key: string,
		arr: unknown,
		defaultArr: string[],
	): string[] {
		if (!Array.isArray(arr) || !arr.every((item) => typeof item === "string")) {
			devWarn(
				`Correcting invalid string array setting for '${key}'. Resetting to default. Received:`,
				arr,
			);
			return [...defaultArr];
		}
		return arr.map((item) => item.trim()).filter(Boolean);
	}

	private validateNonNegativeNumber(
		key: string,
		num: unknown,
		defaultNum: number,
	): number {
		if (typeof num === "number" && Number.isFinite(num) && num >= 0) {
			return num;
		}
		devWarn(
			`Correcting invalid number setting for '${key}' (was ${num}). Resetting to default (${defaultNum}).`,
		);
		return defaultNum;
	}

	async loadSettings(): Promise<KoreaderHighlightImporterSettings> {
		devLog("Loading KOReader Importer settings...");
		const loadedData =
			((await this.plugin.loadData()) as Partial<KoreaderHighlightImporterSettings> | null) ??
			{};
		devLog("Raw loaded data from vault:", loadedData);

		const settings: KoreaderHighlightImporterSettings = {
			...DEFAULT_SETTINGS,
			frontmatter: { ...DEFAULT_SETTINGS.frontmatter },
			template: { ...DEFAULT_SETTINGS.template },
		};

		// Merge top-level properties from loadedData except 'frontmatter' and 'template'
		for (const key in loadedData) {
			if (key === "frontmatter" || key === "template") continue;
			if (Object.hasOwn(loadedData, key)) {
				// Only assign if the key is a valid top-level key in settings
				if (Object.hasOwn(settings, key)) {
					(settings as any)[key] = (loadedData as any)[key];
				}
			}
		}

		// --- Validate and Merge `frontmatter` ---
		if (Object.hasOwn(loadedData, "frontmatter")) {
			if (
				typeof loadedData.frontmatter === "object" &&
				loadedData.frontmatter !== null
			) {
				settings.frontmatter = {
					...DEFAULT_SETTINGS.frontmatter,
					...(loadedData.frontmatter as Partial<FrontmatterSettings>),
				};
			} else {
				devWarn(
					"Correcting invalid 'frontmatter' setting (expected object, got " +
						typeof loadedData.frontmatter +
						"). Resetting to default.",
				);
			}
		}

		// --- Validate and Merge `template` ---
		if (Object.hasOwn(loadedData, "template")) {
			if (
				typeof loadedData.template === "object" &&
				loadedData.template !== null
			) {
				settings.template = {
					...DEFAULT_SETTINGS.template,
					...(loadedData.template as Partial<KoreaderTemplateSettings>),
				};
			} else {
				devWarn(
					"Correcting invalid 'template' setting (expected object, got " +
						typeof loadedData.template +
						"). Resetting to default.",
				);
				// settings.template is already a deep copy of DEFAULT_SETTINGS.template
			}
		}

		// --- detailed validation on all fields of 'settings' object ---
		settings.koboMountPoint = this.validateType(
			settings,
			"koboMountPoint",
			"string",
			DEFAULT_SETTINGS.koboMountPoint,
		);

		settings.highlightsFolder = this.validateType(
			settings,
			"highlightsFolder",
			"string",
			DEFAULT_SETTINGS.highlightsFolder,
		);

		settings.debugMode = this.validateType(
			settings,
			"debugMode",
			"boolean",
			DEFAULT_SETTINGS.debugMode,
		);

		settings.enableFullDuplicateCheck = this.validateType(
			settings,
			"enableFullDuplicateCheck",
			"boolean",
			DEFAULT_SETTINGS.enableFullDuplicateCheck,
		);

		// Validate array properties
		settings.excludedFolders = this.validateStringArray(
			"excludedFolders",
			settings.excludedFolders,
			DEFAULT_SETTINGS.excludedFolders,
		);

		if (
			!Array.isArray(settings.allowedFileTypes) ||
			!settings.allowedFileTypes.every((item) => typeof item === "string")
		) {
			devWarn(
				`Correcting invalid string array setting for 'allowedFileTypes'. Resetting to default. Received:`,
				settings.allowedFileTypes,
			);
			settings.allowedFileTypes = [...DEFAULT_SETTINGS.allowedFileTypes];
		} else {
			settings.allowedFileTypes = settings.allowedFileTypes
				.map((type) => type.trim().toLowerCase())
				.filter(Boolean);
		}

		// Validate frontmatter sub-fields
		const fm = settings.frontmatter as FrontmatterSettings;
		fm.disabledFields = this.validateStringArray(
			"frontmatter.disabledFields",
			fm.disabledFields,
			DEFAULT_SETTINGS.frontmatter.disabledFields,
		);
		fm.customFields = this.validateStringArray(
			"frontmatter.customFields",
			fm.customFields,
			DEFAULT_SETTINGS.frontmatter.customFields,
		);

		// Validate template sub-fields
		const tmpl = settings.template as KoreaderTemplateSettings;
		tmpl.useCustomTemplate = this.validateType(
			tmpl,
			"useCustomTemplate",
			"boolean",
			DEFAULT_SETTINGS.template.useCustomTemplate,
		);

		tmpl.source = this.validateEnum(
			tmpl,
			"source",
			["vault", "external"],
			DEFAULT_SETTINGS.template.source,
			`Correcting invalid 'template.source' (was ${tmpl.source}). Resetting to default.`,
		);

		tmpl.selectedTemplate = this.validateType(
			tmpl,
			"selectedTemplate",
			"string",
			DEFAULT_SETTINGS.template.selectedTemplate,
		);

		if (typeof tmpl.selectedTemplate === "string") {
			tmpl.selectedTemplate = tmpl.selectedTemplate.trim();
		}

		tmpl.templateDir = this.validateType(
			tmpl,
			"templateDir",
			"string",
			DEFAULT_SETTINGS.template.templateDir,
		);

		// Validate debugLevel with enum validation
		const validLevels = [0, 1, 2, 3] as const;
		settings.debugLevel = this.validateEnum<0 | 1 | 2 | 3>(
			settings,
			"debugLevel",
			validLevels,
			DEFAULT_SETTINGS.debugLevel,
			`Correcting invalid 'debugLevel' (${settings.debugLevel}). Resetting to default (${DEFAULT_SETTINGS.debugLevel}).`,
		);

		// Validate numeric properties
		settings.maxHighlightGap = this.validateNonNegativeNumber(
			"maxHighlightGap",
			settings.maxHighlightGap,
			DEFAULT_SETTINGS.maxHighlightGap,
		);

		settings.maxTimeGapMinutes = this.validateNonNegativeNumber(
			"maxTimeGapMinutes",
			settings.maxTimeGapMinutes,
			DEFAULT_SETTINGS.maxTimeGapMinutes,
		);

		settings.mergeOverlappingHighlights = this.validateType(
			settings,
			"mergeOverlappingHighlights",
			"boolean",
			DEFAULT_SETTINGS.mergeOverlappingHighlights,
		);

		devLog("Settings loaded and validated:", settings);
		return settings;
	}

	async saveSettings(
		settings: KoreaderHighlightImporterSettings,
	): Promise<void> {
		devLog("Saving KOReader Importer settings...");
		try {
			await this.plugin.saveData(settings);
			devLog("Settings saved successfully.");
		} catch (error) {
			devError("Failed to save settings:", error);
		}
	}
}
