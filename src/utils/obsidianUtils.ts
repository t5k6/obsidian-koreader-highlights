import { type App, TFile, parseYaml, type FrontMatterCache } from "obsidian";

// A regex to match a YAML frontmatter block at the start of a string.
const FRONTMATTER_REGEX = /^---\s*?\r?\n([\s\S]+?)\r?\n---\s*?\r?\n?/;

type FileOrContent = TFile | { content: string };

export async function getFrontmatterAndBody(
	app: App,
	fileOrContent: FileOrContent,
): Promise<{ frontmatter: FrontMatterCache | undefined; body: string }> {
	let content: string;
	let frontmatter: FrontMatterCache | undefined;

	if (fileOrContent instanceof TFile) {
		// --- Path 1: It's a real file, use the reliable metadataCache ---
		content = await app.vault.read(fileOrContent);
		const cache = app.metadataCache.getFileCache(fileOrContent);
		frontmatter = cache?.frontmatter;
	} else {
		// --- Path 2: It's a raw string, parse it manually ---
		content = fileOrContent.content;
		const match = content.match(FRONTMATTER_REGEX);

		if (match) {
			const yamlBlock = match[1];
			try {
				frontmatter = parseYaml(yamlBlock) ?? {};
			} catch (e) {
				console.error("Failed to parse frontmatter from string", e);
				frontmatter = {};
			}
		}
	}

	// Determine where the body starts
	const bodyContent = content.replace(FRONTMATTER_REGEX, "").trimStart();

	return { frontmatter, body: bodyContent };
}