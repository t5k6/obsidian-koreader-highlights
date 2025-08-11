import type { DocProps } from "src/types";

function normalizeForKey(s: string): string {
	if (!s) return "";
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // strip accents
		.replace(/&/g, " and ")
		.replace(/['’‘"`]+/g, "") // strip quotes
		.replace(/[^a-z0-9]+/g, " ") // squash non-alphanumeric characters
		.trim()
		.replace(/\s+/g, "-"); // convert to kebab-case
}

export function expectedNameKeysFromDocProps(
	doc: DocProps,
	useCustomTemplate: boolean,
	fileNameTemplate: string,
): string[] {
	const title = normalizeForKey(doc.title || "");
	const authors = normalizeForKey(doc.authors || "");
	const keys = new Set<string>();

	// Add common combinations
	if (title && authors) {
		keys.add(`${title}-${authors}`);
		keys.add(`${authors}-${title}`);
	}
	if (title) keys.add(title);
	if (authors) keys.add(authors);

	// Add template-aware combination
	if (
		useCustomTemplate &&
		fileNameTemplate?.includes("{{title}}") &&
		fileNameTemplate?.includes("{{authors}}")
	) {
		const titleFirst =
			fileNameTemplate.indexOf("{{title}}") <
			fileNameTemplate.indexOf("{{authors}}");
		if (title && authors) {
			keys.add(titleFirst ? `${title}-${authors}` : `${authors}-${title}`);
		}
	}

	return [...keys];
}

export function nameKeyFromBasename(basename: string): string {
	let stem = basename;
	stem = stem.replace(/\s*[[(].*?[\])]\s*$/g, ""); // strip trailing bracketed suffixes like [pdf]
	stem = stem.replace(/\s*\(\d+\)\s*$/g, ""); // strip trailing copy number like (1)
	return normalizeForKey(stem);
}

export function keysMatchLoose(a: string, b: string): boolean {
	if (a === b) return true;
	if (!a || !b) return false;

	const as = new Set(a.split("-").filter(Boolean));
	const bs = new Set(b.split("-").filter(Boolean));

	const intersection = [...as].filter((t) => bs.has(t)).length;
	const minSize = Math.min(as.size, bs.size);

	// Require >75% of tokens in the smaller set to be present in the larger set.
	return minSize > 0 && intersection / minSize >= 0.75;
}
