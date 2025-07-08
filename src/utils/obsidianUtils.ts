import { type App, type FrontMatterCache, parseYaml, TFile } from "obsidian";
import { logger } from "src/utils/logging";

// A regex to match a YAML frontmatter block at the start of a string.
const FRONTMATTER_REGEX = /^---\s*?\r?\n([\s\S]+?)\r?\n---\s*?\r?\n?/;

type FileOrContent = TFile | { content: string };

export async function getFrontmatterAndBody(
	app: App,
	fileOrContent: FileOrContent,
): Promise<{ frontmatter: FrontMatterCache | undefined; body: string }> {
	let content: string;
	let frontmatter: FrontMatterCache | undefined;
	let body: string;

	if (fileOrContent instanceof TFile) {
		content = await app.vault.read(fileOrContent);
		const cache = app.metadataCache.getFileCache(fileOrContent);
		frontmatter = cache?.frontmatter;

		if (cache?.frontmatterPosition) {
			// Precise path: Use slice and do not trim.
			body = content.slice(cache.frontmatterPosition.end.offset);
		} else {
			// Fallback path: Use regex and trim.
			body = content.replace(FRONTMATTER_REGEX, "").trimStart();
		}
	} else {
		content = fileOrContent.content;
		const match = content.match(FRONTMATTER_REGEX);

		if (match) {
			const yamlBlock = match[1];
			try {
				frontmatter = parseYaml(yamlBlock) ?? {};
			} catch (e) {
				logger.error(
					"obsidianUtils: Failed to parse YAML from raw content string:",
					e,
				);
				frontmatter = {};
			}
		}
		// Fallback path for strings: Use regex and trim.
		body = content.replace(FRONTMATTER_REGEX, "").trimStart();
	}

	return { frontmatter, body };
}
