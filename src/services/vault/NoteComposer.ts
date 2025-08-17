import type { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { ContentGenerator } from "src/services/vault/ContentGenerator";
import type { FrontmatterSettings, LuaMetadata } from "src/types";

export async function composeFullNoteContent(
	deps: {
		fmGen: FrontmatterGenerator;
		fmService: FrontmatterService;
		contentGen: ContentGenerator;
		fmSettings: FrontmatterSettings;
	},
	lua: LuaMetadata,
	uid?: string,
): Promise<string> {
	const fm = deps.fmGen.createFrontmatterData(lua, deps.fmSettings, uid);
	const body = await deps.contentGen.generateHighlightsContent(
		lua.annotations ?? [],
	);
	return deps.fmService.reconstructFileContent(fm, body);
}

export async function composeBodyOnly(
	contentGen: ContentGenerator,
	lua: LuaMetadata,
): Promise<string> {
	return contentGen.generateHighlightsContent(lua.annotations ?? []);
}
