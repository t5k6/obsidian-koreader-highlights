import type { App, CachedMetadata, TFile } from "obsidian";

export async function getFrontmatterAndBody(app: App, file: TFile) {
	const fileCache: CachedMetadata | null = app.metadataCache.getFileCache(file);

	const frontmatter = fileCache?.frontmatter;
	const content = await app.vault.read(file);

	const bodyContent = fileCache?.frontmatterPosition
		? content.slice(fileCache.frontmatterPosition.end.offset)
		: content;

	return { frontmatter, body: bodyContent };
}
