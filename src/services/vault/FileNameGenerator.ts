import {
	getFileNameWithoutExt,
	normalizeFileNamePiece,
	simplifySdrName,
} from "src/lib/pathing/pathingUtils";
import type { LoggingService } from "src/services/LoggingService";
import type { DocProps } from "src/types";

const MAX_TOTAL_PATH_LENGTH = 255;
const FILE_EXTENSION = ".md";

export class FileNameGenerator {
	private readonly log;
	constructor(private loggingService: LoggingService) {
		this.log = this.loggingService.scoped("FileNameGenerator");
	}

	/**
	 * Renders a template string with the provided data.
	 */
	private static renderTemplate(
		template: string,
		data: Record<string, string>,
	): string {
		return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] || "");
	}

	/**
	 * Generates an Obsidian-compatible filename based on a user-defined template.
	 * @param template The user's format string, e.g., "{{title}} - {{authors}}".
	 * @param docProps The metadata properties of the book.
	 * @param originalSdrName The original .sdr folder name, used as a fallback.
	 * @returns A sanitized, ready-to-use filename (e.g., "Moby Dick - Herman Melville.md").
	 */
	public generate(
		options: {
			useCustomTemplate: boolean;
			template: string;
			highlightsFolder: string;
		},
		docProps: DocProps,
		originalSdrName?: string,
	): string {
		let baseName: string;

		if (options.useCustomTemplate) {
			// --- Custom Template Logic ---
			const templateData: Record<string, string> = {
				title: docProps.title?.trim() || "Untitled",
				authors: docProps.authors?.trim() || "Unknown Author",
				importDate: new Date().toISOString().split("T")[0],
			};
			baseName = FileNameGenerator.renderTemplate(
				options.template,
				templateData,
			);
		} else {
			// --- Ranked Default Logic ---
			baseName = this._generateDefaultFileName(docProps, originalSdrName);
		}

		// --- Fallback and Sanitization ---
		if (!baseName?.trim()) {
			baseName =
				simplifySdrName(getFileNameWithoutExt(originalSdrName)) || "Untitled";
			this.log.warn(
				`Generated filename was empty. Falling back to SDR-based name: "${baseName}"`,
			);
		}

		const sanitized = normalizeFileNamePiece(baseName);

		if (!sanitized) {
			this.log.error(
				"Could not generate a valid filename after sanitization. Defaulting to 'Untitled'.",
				{ docProps, originalSdrName },
			);
			return `Untitled${FILE_EXTENSION}`;
		}

		// Critical path length validation.
		const reservedLength =
			options.highlightsFolder.length + FILE_EXTENSION.length + 1 + 5; // +1 for slash, +5 margin
		const maxBaseNameLength = MAX_TOTAL_PATH_LENGTH - reservedLength;

		let finalBaseName = sanitized;
		if (sanitized.length > maxBaseNameLength) {
			finalBaseName = sanitized.slice(0, maxBaseNameLength);
			this.log.warn(
				`Filename truncated to fit path limits: "${sanitized}" -> "${finalBaseName}"`,
			);
		}

		return `${finalBaseName}${FILE_EXTENSION}`;
	}

	/**
	 * Implements the ranked default naming strategy.
	 */
	private _generateDefaultFileName(
		docProps: DocProps,
		originalSdrName?: string,
	): string {
		const title = docProps.title?.trim();
		const authors = docProps.authors?.trim();
		const sdrBase = simplifySdrName(getFileNameWithoutExt(originalSdrName));

		if (authors && title) {
			return `${authors} - ${title}`;
		}
		if (authors) {
			return `${authors} - ${sdrBase}`;
		}
		if (title) {
			return title;
		}
		return sdrBase;
	}

	/**
	 * Validates a filename template string.
	 * @param template The template string to validate.
	 * @returns An object with isValid, errors, and warnings.
	 */
	public validate(template: string): {
		isValid: boolean;
		errors: string[];
		warnings: string[];
	} {
		const result = {
			isValid: true,
			errors: [] as string[],
			warnings: [] as string[],
		};
		const validPlaceholders = new Set(["title", "authors", "importDate"]);

		const placeholders = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(
			(m) => m[1],
		);

		if (placeholders.length === 0 && template.trim()) {
			// It's a static filename, which is valid but maybe not intended.
			result.warnings.push(
				"Template has no placeholders like {{title}}. The filename will be static.",
			);
		} else {
			placeholders.forEach((p) => {
				if (!validPlaceholders.has(p)) {
					result.errors.push(`Invalid placeholder: {{${p}}}`);
					result.isValid = false;
				}
			});
		}

		if (
			result.isValid &&
			!placeholders.includes("title") &&
			!placeholders.includes("authors")
		) {
			result.warnings.push(
				"It's recommended to include {{title}} or {{authors}} to ensure unique filenames.",
			);
		}

		return result;
	}
}
