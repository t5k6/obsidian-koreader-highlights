import { parseYaml, stringifyYaml } from "obsidian";
import { err, ok, type Result } from "./core/result";

/**
 * The canonical regex for detecting and extracting YAML frontmatter.
 */
export const FRONTMATTER_REGEX = /^---\s*?\r?\n([\s\S]+?)\r?\n---/;

export interface ParsedFrontmatter {
	hash: string | null;
	body: string;
	yamlContent: string;
}

/**
 * Parse content with front-matter, extracting hash and body.
 * The returned `body` is **verbatim**: every character after the closing
 * '---' line (including one or several newline characters) is preserved.
 */
export function parseFrontmatter(
	content: string,
): Result<ParsedFrontmatter, { kind: "YamlParseError"; message: string }> {
	const match = content.match(FRONTMATTER_REGEX);

	if (!match) {
		return ok({
			hash: null,
			body: content,
			yamlContent: "",
		});
	}

	const yamlContent = match[1] ?? "";
	const body = content.slice(match[0].length);

	try {
		const frontmatter = parseYaml(yamlContent) as Record<
			string,
			unknown
		> | null;
		const hash =
			frontmatter && typeof frontmatter.sha256 === "string"
				? frontmatter.sha256
				: null;

		return ok({
			hash,
			body,
			yamlContent,
		});
	} catch (error) {
		return err({
			kind: "YamlParseError",
			message: `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

/**
 * Compose content with frontmatter, ensuring consistent formatting.
 * A blank line (\n\n) is always inserted between the frontmatter and the body.
 * The body content's own whitespace is preserved.
 */
export function composeFrontmatter(
	fields: Record<string, unknown>,
	body: string,
): string {
	const yamlContent = stringifyYaml(fields).trim();
	return `---\n${yamlContent}\n---\n\n${body}`;
}
