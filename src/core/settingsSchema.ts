import {
	DEFAULT_HIGHLIGHTS_FOLDER,
	DEFAULT_LOGS_FOLDER,
	DEFAULT_TEMPLATES_FOLDER,
} from "src/constants";
import { Pathing } from "src/lib/pathing";
import type { KoreaderHighlightImporterSettings, PluginData } from "src/types";
import { CURRENT_SCHEMA_VERSION } from "src/types";
import { z } from "zod";
import { deepMerge } from "./deepMerge";

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

// --- Nested schemas (resilient) ---
export const TemplateSchema = z
	.object({
		useCustomTemplate: z.coerce.boolean().catch(false).default(false),
		source: z.enum(["vault", "external"]).catch("vault").default("vault"),
		selectedTemplate: z.string().min(1).catch("default").default("default"),
		templateDir: z
			.string()
			.min(1)
			.catch(DEFAULT_TEMPLATES_FOLDER)
			.default(DEFAULT_TEMPLATES_FOLDER),
	})
	.passthrough();

export const FrontmatterSchema = z
	.object({
		disabledFields: z
			.array(z.string())
			.catch([] as string[])
			.default([] as string[]),
		customFields: z
			.array(z.string())
			.catch([] as string[])
			.default([] as string[]),
		useUnknownAuthor: z.coerce.boolean().catch(false).default(false),
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
		maxBackupsPerNote: z.coerce
			.number()
			.int()
			.min(0)
			.catch(() => BASE_DEFAULTS.maxBackupsPerNote)
			.optional(),
		scanTimeoutSeconds: z.coerce
			.number()
			.int()
			.min(1)
			.catch(() => BASE_DEFAULTS.scanTimeoutSeconds)
			.optional(),
		lastDeviceTimestamp: z.string().optional(),

		// Nested blocks (optional + partial + strip)
		template: TemplateSchema.partial().optional(),
		frontmatter: FrontmatterSchema.partial().optional(),
	})
	.strip();

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
	maxBackupsPerNote: 5,
	scanTimeoutSeconds: 8,
	template: {
		useCustomTemplate: false,
		source: "vault",
		selectedTemplate: "default",
		templateDir: DEFAULT_TEMPLATES_FOLDER,
	},
	frontmatter: {
		disabledFields: [],
		customFields: [],
		useUnknownAuthor: false,
	},
};

export function normalizeSettings(
	raw: unknown,
): KoreaderHighlightImporterSettings {
	// 1. Parse raw data using Zod schema. Fallback to an empty object on failure.
	const parsedRes = RawSettingsSchema.safeParse(raw ?? {});
	const parsedData = parsedRes.success ? parsedRes.data : {};

	// 2. Create a mutable copy and handle legacy key migration.
	// We use a type assertion here because Zod's inferred type from a partial & optional schema
	// is more complex than our target Partial type.
	const migratedData = {
		...parsedData,
	} as Partial<KoreaderHighlightImporterSettings> & {
		koreaderMountPoint?: string;
	};

	if (
		migratedData.koreaderScanPath == null &&
		typeof migratedData.koreaderMountPoint === "string"
	) {
		migratedData.koreaderScanPath = migratedData.koreaderMountPoint;
	}
	// Always remove the legacy key to prevent it from being saved.
	delete migratedData.koreaderMountPoint;

	// 3. Deep-merge the validated & migrated data onto the base defaults.
	const merged = deepMerge(BASE_DEFAULTS, migratedData);

	// 4. Perform all post-merge normalizations (path handling, boolean coercion, array cleanup).
	merged.koreaderScanPath = Pathing.normalizeSystemPath(
		merged.koreaderScanPath,
	);
	merged.statsDbPathOverride = merged.statsDbPathOverride
		? Pathing.normalizeSystemPath(merged.statsDbPathOverride)
		: "";
	merged.highlightsFolder = Pathing.toVaultPath(merged.highlightsFolder);
	merged.logsFolder = Pathing.toVaultPath(merged.logsFolder);
	merged.template.templateDir = Pathing.toVaultPath(
		merged.template.templateDir,
	);

	const rawObj = (raw ?? {}) as Record<string, unknown>;
	if ("logToFile" in rawObj) {
		merged.logToFile = coerceBoolLoose(rawObj.logToFile);
	}
	if (
		rawObj.frontmatter &&
		typeof rawObj.frontmatter === "object" &&
		rawObj.frontmatter !== null &&
		"useUnknownAuthor" in rawObj.frontmatter
	) {
		merged.frontmatter.useUnknownAuthor = coerceBoolLoose(
			(rawObj.frontmatter as any).useUnknownAuthor,
		);
	}

	merged.excludedFolders = merged.excludedFolders
		.map((f) => String(f).trim())
		.filter(Boolean);
	merged.frontmatter.disabledFields = merged.frontmatter.disabledFields
		.map((f) => String(f).trim())
		.filter(Boolean);

	merged.allowedFileTypes = Array.isArray(merged.allowedFileTypes)
		? merged.allowedFileTypes.map((s) => String(s).toLowerCase())
		: [...BASE_DEFAULTS.allowedFileTypes];

	return merged;
}

// Canonical default settings value used by tests and callers that need a baseline
export const DEFAULT_SETTINGS: KoreaderHighlightImporterSettings =
	normalizeSettings({});

// Type-safe data normalization function
export function normalizePluginData(raw: unknown): PluginData {
	// Type-safe property access
	const rawObj =
		raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

	return {
		schemaVersion:
			typeof rawObj.schemaVersion === "number" &&
			Number.isInteger(rawObj.schemaVersion)
				? rawObj.schemaVersion
				: CURRENT_SCHEMA_VERSION,
		settings: normalizeSettings(rawObj.settings),
		appliedMigrations: Array.isArray(rawObj.appliedMigrations)
			? rawObj.appliedMigrations.filter(
					(x): x is string => typeof x === "string",
				)
			: [],
		lastPluginMigratedTo:
			typeof rawObj.lastPluginMigratedTo === "string"
				? rawObj.lastPluginMigratedTo
				: undefined,
	};
}
