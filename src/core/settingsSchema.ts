import {
	DEFAULT_HIGHLIGHTS_FOLDER,
	DEFAULT_LOGS_FOLDER,
	DEFAULT_TEMPLATES_FOLDER,
} from "src/constants";
import { FileSystemService } from "src/services/FileSystemService";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { z } from "zod";

function coerceBoolLoose(v: unknown): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v === 1;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		if (["true", "1", "yes", "y", "on"].includes(s)) return true;
		if (["false", "0", "no", "n", "off", ""].includes(s)) return false;
		return false;
	}
	return false;
}

// --- Nested defaults ---
export const TEMPLATE_DEFAULTS = {
	useCustomTemplate: false,
	source: "vault" as const,
	selectedTemplate: "default",
	templateDir: DEFAULT_TEMPLATES_FOLDER,
};

export const FRONTMATTER_DEFAULTS = {
	disabledFields: [] as string[],
	customFields: [] as string[],
	useUnknownAuthor: false,
};

// --- Nested schemas (resilient) ---
export const TemplateSchema = z
	.object({
		useCustomTemplate: z.coerce
			.boolean()
			.catch(TEMPLATE_DEFAULTS.useCustomTemplate)
			.default(TEMPLATE_DEFAULTS.useCustomTemplate),
		source: z
			.enum(["vault", "external"])
			.catch(TEMPLATE_DEFAULTS.source)
			.default(TEMPLATE_DEFAULTS.source),
		selectedTemplate: z
			.string()
			.min(1)
			.catch(TEMPLATE_DEFAULTS.selectedTemplate)
			.default(TEMPLATE_DEFAULTS.selectedTemplate),
		templateDir: z
			.string()
			.min(1)
			.catch(TEMPLATE_DEFAULTS.templateDir)
			.default(TEMPLATE_DEFAULTS.templateDir),
	})
	.passthrough();

export const FrontmatterSchema = z
	.object({
		disabledFields: z
			.array(z.string())
			.catch(FRONTMATTER_DEFAULTS.disabledFields)
			.default(FRONTMATTER_DEFAULTS.disabledFields),
		customFields: z
			.array(z.string())
			.catch(FRONTMATTER_DEFAULTS.customFields)
			.default(FRONTMATTER_DEFAULTS.customFields),
		useUnknownAuthor: z.coerce
			.boolean()
			.catch(FRONTMATTER_DEFAULTS.useUnknownAuthor)
			.default(FRONTMATTER_DEFAULTS.useUnknownAuthor),
	})
	.passthrough();

// --- Raw/partial schema for loading ---
export const RawSettingsSchema = z
	.object({
		koreaderScanPath: z.string().optional(),
		statsDbPathOverride: z.string().optional(),
		// Legacy key accepted to migrate to koreaderScanPath
		koreaderMountPoint: z.string().optional(),
		excludedFolders: z.array(z.string()).optional(),
		// Be resilient: accept bad arrays and default later
		allowedFileTypes: z
			.array(z.string())
			.catch(() => BASE_DEFAULTS.allowedFileTypes)
			.optional(),
		highlightsFolder: z.string().optional(),
		logToFile: z.coerce.boolean().optional(),
		logLevel: z
			.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
			.catch(() => BASE_DEFAULTS.logLevel)
			.optional(),
		logsFolder: z.string().optional(),
		enableFullDuplicateCheck: z.coerce.boolean().optional(),
		fileNameTemplate: z.string().optional(),
		useCustomFileNameTemplate: z.coerce.boolean().optional(),
		autoMergeOnAddition: z.coerce
			.boolean()
			.catch(() => BASE_DEFAULTS.autoMergeOnAddition)
			.optional(),
		maxHighlightGap: z.coerce
			.number()
			.int()
			.min(0)
			.catch(() => BASE_DEFAULTS.maxHighlightGap)
			.optional(),
		maxTimeGapMinutes: z.coerce
			.number()
			.int()
			.min(0)
			.catch(() => BASE_DEFAULTS.maxTimeGapMinutes)
			.optional(),
		mergeOverlappingHighlights: z.coerce
			.boolean()
			.catch(() => BASE_DEFAULTS.mergeOverlappingHighlights)
			.optional(),
		commentStyle: z.enum(["html", "md", "none"]).optional(),
		backupRetentionDays: z.coerce
			.number()
			.int()
			.min(0)
			.catch(() => BASE_DEFAULTS.backupRetentionDays)
			.optional(),
		scanTimeoutSeconds: z.coerce
			.number()
			.int()
			.min(1)
			.catch(() => BASE_DEFAULTS.scanTimeoutSeconds)
			.optional(),
		lastDeviceTimestamp: z.string().optional(),

		// Nested blocks (optional + partial + passthrough)
		template: TemplateSchema.partial().optional(),
		frontmatter: FrontmatterSchema.partial().optional(),
	})
	.passthrough();

// --- Deep merge utility (arrays replaced) ---
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge<T>(base: T, next: Partial<T>): T {
	const out: any = Array.isArray(base)
		? [...(base as any)]
		: { ...(base as any) };
	for (const [k, v] of Object.entries(next ?? {})) {
		if (v === undefined) continue;
		if (isPlainObject(v) && isPlainObject(out[k]))
			out[k] = deepMerge(out[k], v as any);
		else out[k] = v as any;
	}
	return out as T;
}

// --- Base defaults (no circular refs) ---
export const BASE_DEFAULTS: KoreaderHighlightImporterSettings = {
	koreaderScanPath: "",
	statsDbPathOverride: "",
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
	highlightsFolder: DEFAULT_HIGHLIGHTS_FOLDER,
	logToFile: false,
	logLevel: 1 as 0 | 1 | 2 | 3,
	logsFolder: DEFAULT_LOGS_FOLDER,
	enableFullDuplicateCheck: false,
	fileNameTemplate: "{{title}} - {{authors}}",
	useCustomFileNameTemplate: false,
	autoMergeOnAddition: true,
	maxHighlightGap: 5,
	maxTimeGapMinutes: 10,
	mergeOverlappingHighlights: true,
	commentStyle: "html" as const,
	backupRetentionDays: 30,
	scanTimeoutSeconds: 8,
	template: TEMPLATE_DEFAULTS,
	frontmatter: FRONTMATTER_DEFAULTS,
};

export function normalizeSettings(
	raw: unknown,
): KoreaderHighlightImporterSettings {
	const parsed = RawSettingsSchema.safeParse(raw ?? {});
	const partialRaw = (parsed.success ? parsed.data : {}) as any;

	// Migrate legacy key to new canonical key in-memory before deep merge
	const partial: Partial<KoreaderHighlightImporterSettings> = {
		...(partialRaw as any),
	} as any;
	if (
		(partial as any).koreaderScanPath == null &&
		typeof partialRaw.koreaderMountPoint === "string"
	) {
		(partial as any).koreaderScanPath = partialRaw.koreaderMountPoint;
		delete (partial as any).koreaderMountPoint;
	}

	const merged = deepMerge(
		BASE_DEFAULTS,
		partial as Partial<KoreaderHighlightImporterSettings>,
	) as KoreaderHighlightImporterSettings;

	// Post-parse normalizations
	merged.koreaderScanPath = FileSystemService.normalizeSystemPath(
		merged.koreaderScanPath,
	);
	// Normalize override as well (leave empty string as-is for disabled override)
	merged.statsDbPathOverride = merged.statsDbPathOverride
		? FileSystemService.normalizeSystemPath(merged.statsDbPathOverride)
		: "";
	merged.highlightsFolder = FileSystemService.toVaultPath(
		merged.highlightsFolder,
	);
	merged.logsFolder = FileSystemService.toVaultPath(merged.logsFolder);
	merged.template.templateDir = FileSystemService.toVaultPath(
		merged.template.templateDir,
	);

	// Override booleans with strict coercion from raw input when provided
	const rawObj = (raw ?? {}) as any;
	if ("logToFile" in (rawObj || {})) {
		merged.logToFile = coerceBoolLoose(rawObj.logToFile);
	}
	if (rawObj?.frontmatter && "useUnknownAuthor" in rawObj.frontmatter) {
		merged.frontmatter.useUnknownAuthor = coerceBoolLoose(
			rawObj.frontmatter.useUnknownAuthor,
		);
	}

	// Clean arrays: trim and drop empties
	if (Array.isArray(merged.excludedFolders)) {
		merged.excludedFolders = merged.excludedFolders
			.map((s) => (typeof s === "string" ? s.trim() : ""))
			.filter((s) => s.length > 0);
	}
	if (Array.isArray(merged.frontmatter?.disabledFields)) {
		merged.frontmatter.disabledFields = merged.frontmatter.disabledFields
			.map((s) => (typeof s === "string" ? s.trim() : ""))
			.filter((s) => s.length > 0);
	}

	// Guard allowedFileTypes; default if any non-string present
	if (
		!Array.isArray(merged.allowedFileTypes) ||
		merged.allowedFileTypes.some((v) => typeof v !== "string")
	) {
		merged.allowedFileTypes = [...BASE_DEFAULTS.allowedFileTypes];
	} else {
		merged.allowedFileTypes = merged.allowedFileTypes.map((s) =>
			(typeof s === "string" ? s : "").toLowerCase(),
		);
	}

	return merged;
}

// Canonical default settings value used by tests and callers that need a baseline
export const DEFAULT_SETTINGS: KoreaderHighlightImporterSettings =
	normalizeSettings({});
