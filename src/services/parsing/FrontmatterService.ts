import { type FrontMatterCache, parseYaml, stringifyYaml } from "obsidian";
import type { LoggingService } from "src/services/LoggingService";

// A regex to match a YAML frontmatter block at the start of a string.
const FRONTMATTER_REGEX = /^---\s*?\r?\n([\s\S]+?)\r?\n---\s*?\r?\n?/s;

export class FrontmatterService {
	private readonly SCOPE = "FrontmatterService";
	constructor(private readonly loggingService: LoggingService) {}

	/**
	 * Parses a raw string to separate its frontmatter and body content.
	 * @param content The full content of a note.
	 * @returns An object containing the parsed frontmatter and the body.
	 */
	public parse(content: string): {
		frontmatter: FrontMatterCache;
		body: string;
	} {
		const match = content.match(FRONTMATTER_REGEX);
		let frontmatter: FrontMatterCache = {};
		let body = content;

		if (match) {
			const yamlBlock = match[1];
			body = content.slice(match[0].length);
			try {
				// Use an empty object as a fallback for invalid YAML
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
	 * Converts a data object into a YAML frontmatter string.
	 * @param data The object to stringify.
	 * @returns A formatted YAML string, including the '---' delimiters. Returns an empty string if the data object is empty.
	 */
	public stringify(data: Record<string, unknown>): string {
		if (!data || Object.keys(data).length === 0) {
			return "";
		}

		// Ensure there are no undefined values, as stringifyYaml handles them poorly.
		const cleanedData: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (value !== undefined && value !== null) {
				cleanedData[key] = value;
			}
		}

		if (Object.keys(cleanedData).length === 0) {
			return "";
		}

		return `---\n${stringifyYaml(cleanedData)}---\n`;
	}
}
