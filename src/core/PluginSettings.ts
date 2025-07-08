import type { Plugin } from "obsidian";
import { logger } from "src/utils/logging";
import type {
	KoreaderHighlightImporterSettings,
	KoreaderTemplateSettings,
} from "../types";

/* ------------------------------------------------------------------ */
/*                   1.  DEFAULTS                         			  */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: KoreaderHighlightImporterSettings = {
	koreaderMountPoint: "",
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
	debugLevel: 1,
	enableFullDuplicateCheck: false,
	autoMergeOnAddition: true,
	frontmatter: {
		disabledFields: [],
		customFields: [],
		useUnknownAuthor: false,
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

/* ------------------------------------------------------------------ */
/*                   2.  SCHEMA 						              */
/* ------------------------------------------------------------------ */

type Primitive = string | number | boolean;

interface FieldRule<T = Primitive> {
	key: keyof KoreaderHighlightImporterSettings;
	type: "string" | "number" | "boolean";
	default: T;
	normalize?: (v: any) => T;
	validate?: (v: any) => boolean;
}

const FIELD_RULES: FieldRule[] = [
	{
		key: "koreaderMountPoint",
		type: "string",
		default: DEFAULT_SETTINGS.koreaderMountPoint,
	},
	{
		key: "highlightsFolder",
		type: "string",
		default: DEFAULT_SETTINGS.highlightsFolder,
	},
	{ key: "debugMode", type: "boolean", default: DEFAULT_SETTINGS.debugMode },
	{
		key: "debugLevel",
		type: "number",
		default: DEFAULT_SETTINGS.debugLevel,
		validate: (v) => [0, 1, 2, 3].includes(v),
	},
	{
		key: "enableFullDuplicateCheck",
		type: "boolean",
		default: DEFAULT_SETTINGS.enableFullDuplicateCheck,
	},
	{
		key: "autoMergeOnAddition",
		type: "boolean",
		default: DEFAULT_SETTINGS.autoMergeOnAddition,
	},
	{
		key: "maxHighlightGap",
		type: "number",
		default: DEFAULT_SETTINGS.maxHighlightGap,
		validate: (v) => typeof v === "number" && v >= 0,
	},
	{
		key: "maxTimeGapMinutes",
		type: "number",
		default: DEFAULT_SETTINGS.maxTimeGapMinutes,
		validate: (v) => typeof v === "number" && v >= 0,
	},
	{
		key: "mergeOverlappingHighlights",
		type: "boolean",
		default: DEFAULT_SETTINGS.mergeOverlappingHighlights,
	},
];

/* utilities for string-array fields */
function sanitizeStringArray(arr: unknown, fallback: string[]): string[] {
	if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string"))
		return [...fallback];
	return arr.map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*                      3.  MAIN CLASS                                 */
/* ------------------------------------------------------------------ */

export class PluginSettings {
	constructor(private plugin: Plugin) {}

	/* ------------------------------ load ---------------------------- */

	public async loadSettings(): Promise<KoreaderHighlightImporterSettings> {
		logger.info("PluginSettings: Loading KOReader Importer settings…");
		const raw =
			((await this.plugin.loadData()) as Partial<KoreaderHighlightImporterSettings> | null) ??
			{};

		/* start with deep-cloned defaults */
		const settings: KoreaderHighlightImporterSettings =
			structuredClone(DEFAULT_SETTINGS);

		/* ---------- 3.1  validate flat primitive fields ----------- */
		for (const rule of FIELD_RULES) {
			const incoming = (raw as any)[rule.key];
			const isValidType = typeof incoming === rule.type;
			const passesCustom = rule.validate ? rule.validate(incoming) : true;

			(settings as any)[rule.key] =
				isValidType && passesCustom
					? rule.normalize
						? rule.normalize(incoming)
						: incoming
					: rule.default;

			if (!isValidType || !passesCustom) {
				logger.warn(
					`PluginSettings: Corrected setting '${rule.key}' → default (${rule.default}).`,
				);
			}
		}

		/* ---------- 3.2  string-array fields ---------------------- */
		settings.excludedFolders = sanitizeStringArray(
			raw.excludedFolders,
			DEFAULT_SETTINGS.excludedFolders,
		);
		settings.allowedFileTypes = sanitizeStringArray(
			raw.allowedFileTypes,
			DEFAULT_SETTINGS.allowedFileTypes,
		).map((s) => s.toLowerCase());

		/* ---------- 3.3  nested objects: frontmatter -------------- */
		if (typeof raw.frontmatter === "object" && raw.frontmatter) {
			settings.frontmatter = {
				...DEFAULT_SETTINGS.frontmatter,
				...raw.frontmatter,
				disabledFields: sanitizeStringArray(
					raw.frontmatter.disabledFields,
					DEFAULT_SETTINGS.frontmatter.disabledFields,
				),
				customFields: sanitizeStringArray(
					raw.frontmatter.customFields,
					DEFAULT_SETTINGS.frontmatter.customFields,
				),
			};
		}

		/* ---------- 3.4  nested objects: template ----------------- */
		if (typeof raw.template === "object" && raw.template) {
			const tmp = raw.template as Partial<KoreaderTemplateSettings>;
			settings.template = {
				...DEFAULT_SETTINGS.template,
				...tmp,
				selectedTemplate: (
					tmp.selectedTemplate ?? DEFAULT_SETTINGS.template.selectedTemplate
				).trim(),
				source: ["vault", "external"].includes(tmp.source as string)
					? (tmp.source as "vault" | "external")
					: DEFAULT_SETTINGS.template.source,
			};
		}

		logger.info("PluginSettings: Settings validated:", settings);
		return settings;
	}

	/* ------------------------------ save ---------------------------- */

	public async saveSettings(
		settings: KoreaderHighlightImporterSettings,
	): Promise<void> {
		try {
			await this.plugin.saveData(settings);
			logger.info("PluginSettings: KOReader Importer settings saved.");
		} catch (e) {
			logger.error("PluginSettings: Failed to save settings", e);
		}
	}
}
