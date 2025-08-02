import {
	type App,
	type FrontMatterCache,
	parseYaml,
	stringifyYaml,
	type TFile,
} from "obsidian";
import type { LoggingService } from "src/services/LoggingService";
import {
	formatDateWithFormat,
	secondsToHoursMinutesSeconds,
} from "src/utils/dateUtils";
import { formatPercent } from "src/utils/formatUtils";

// --- Formatting Constants and Helpers ---
const FRIENDLY_KEY_MAP = {
	title: "Title",
	authors: "Author(s)",
	description: "Description",
	keywords: "Keywords",
	series: "Series",
	language: "Language",
	pages: "Page Count",
	highlightCount: "Highlight Count",
	noteCount: "Note Count",
	lastRead: "Last Read Date",
	firstRead: "First Read Date",
	totalReadTime: "Total Read Duration",
	progress: "Reading Progress",
	readingStatus: "Status",
	averageTimePerPage: "Avg. Time Per Page",
} as const;

type ProgKey = keyof typeof FRIENDLY_KEY_MAP;

function splitAndTrim(s: string, rx: RegExp): string[] {
	return s
		.split(rx)
		.map((x) => x.trim())
		.filter(Boolean);
}

const metaFieldFormatters: Partial<Record<ProgKey, (v: unknown) => unknown>> = {
	lastRead: (v) => formatDateWithFormat(String(v), "YYYY-MM-DD"),
	firstRead: (v) => formatDateWithFormat(String(v), "YYYY-MM-DD"),
	totalReadTime: (v) => secondsToHoursMinutesSeconds(Number(v)),
	averageTimePerPage: (v) => secondsToHoursMinutesSeconds(Number(v) * 60),
	progress: (v) => formatPercent(Number(v)),
	readingStatus: (v) => String(v ?? ""),
	description: (v) => String(v ?? "").replace(/<[^>]+>/g, ""), // strip html
	authors: (v) => {
		if (Array.isArray(v)) return v; // Already formatted as a list
		if (typeof v === "string" && v.startsWith("[[")) return v; // Already a single link
		const arr = splitAndTrim(String(v), /\s*[,;&\n]\s*/);
		const links = arr.map((a) => `[[${a}]]`);
		return links.length === 1 ? links[0] : links;
	},
	keywords: (v) => (Array.isArray(v) ? v : splitAndTrim(String(v), /,/)),
};

export class FrontmatterService {
	private static readonly FRONTMATTER_REGEX =
		/^---\s*?\r?\n([\s\S]+?)\r?\n---\s*?\r?\n?/s;
	private readonly SCOPE = "FrontmatterService";

	constructor(
		private readonly app: App,
		private readonly loggingService: LoggingService,
	) {}

	/**
	 * Asynchronously parses a TFile to separate its frontmatter and body.
	 * Uses Obsidian's metadata cache for improved performance and accuracy.
	 * @param file The TFile to parse.
	 * @returns A promise resolving to an object with the parsed frontmatter and body.
	 */
	public async parseFile(
		file: TFile,
	): Promise<{ frontmatter: FrontMatterCache; body: string }> {
		const content = await this.app.vault.read(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter ?? {};
		let body: string;

		if (cache?.frontmatterPosition) {
			body = content.slice(cache.frontmatterPosition.end.offset);
		} else {
			body = content
				.replace(FrontmatterService.FRONTMATTER_REGEX, "")
				.trimStart();
		}

		return { frontmatter, body };
	}

	/**
	 * Parses a raw string to separate its frontmatter and body content.
	 * @param content The full content of a note.
	 * @returns An object containing the parsed frontmatter and the body.
	 */
	public parseContent(content: string): {
		frontmatter: FrontMatterCache;
		body: string;
	} {
		const match = content.match(FrontmatterService.FRONTMATTER_REGEX);
		let frontmatter: FrontMatterCache = {};
		let body = content;

		if (match) {
			const yamlBlock = match[1];
			body = content.slice(match[0].length);
			try {
				frontmatter = parseYaml(yamlBlock) ?? {};
			} catch (e) {
				this.loggingService.error(
					this.SCOPE,
					"FrontmatterService: Failed to parse YAML block:",
					e,
					yamlBlock,
				);
			}
		}

		return { frontmatter, body };
	}

	/**
	 * Converts a data object into a YAML frontmatter string with advanced formatting.
	 * @param data The object to stringify.
	 * @param options Formatting options like using friendly keys and sorting.
	 * @returns A formatted YAML string, NOT including the '---' delimiters.
	 */
	public stringify(
		data: Record<string, unknown>,
		options: { useFriendlyKeys?: boolean; sortKeys?: boolean } = {},
	): string {
		if (!data || Object.keys(data).length === 0) {
			return "";
		}

		const { useFriendlyKeys = true, sortKeys = true } = options;
		const output: Record<string, unknown> = {};
		const reverseMap = new Map(
			Object.entries(FRIENDLY_KEY_MAP).map(([k, v]) => [v.toLowerCase(), k]),
		);

		let entries = Object.entries(data);
		if (sortKeys) {
			entries = entries.sort(([a], [b]) => a.localeCompare(b));
		}

		for (const [key, rawValue] of entries) {
			if (rawValue === undefined || rawValue === null) continue;

			// Normalize incoming key if it's a friendly key
			const progKey = (reverseMap.get(key.toLowerCase()) ?? key) as ProgKey;

			if (
				useFriendlyKeys &&
				(progKey === "highlightCount" || progKey === "noteCount") &&
				rawValue === 0
			) {
				continue;
			}

			const formatter = metaFieldFormatters[progKey];
			const value = formatter ? formatter(rawValue) : rawValue;

			const keyOut = useFriendlyKeys
				? (FRIENDLY_KEY_MAP[progKey] ?? key)
				: progKey;

			if (value !== "" && (!Array.isArray(value) || value.length > 0)) {
				output[keyOut] = value;
			}
		}

		return Object.keys(output).length > 0 ? stringifyYaml(output) : "";
	}

	/**
	 * Reconstructs the full file content from a frontmatter object and a body string.
	 * @param frontmatter The frontmatter data object.
	 * @param body The main content/body of the note.
	 * @returns The complete string content for a file.
	 */
	public reconstructFileContent(
		frontmatter: Record<string, unknown>,
		body: string,
	): string {
		const yamlString = this.stringify(frontmatter, {
			useFriendlyKeys: true,
			sortKeys: true,
		});

		if (!yamlString) {
			return body.trim();
		}

		return `---\n${yamlString}---\n\n${body.trim()}`;
	}
}
