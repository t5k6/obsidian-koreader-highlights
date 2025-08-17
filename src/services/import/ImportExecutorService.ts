import type KoreaderImporterPlugin from "src/main";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { ContentGenerator } from "src/services/vault/ContentGenerator";
import type { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import type { MergeHandler } from "src/services/vault/MergeHandler";
import type { NoteCreationService } from "src/services/vault/NoteCreationService";
import type { SnapshotManager } from "src/services/vault/SnapshotManager";
import type {
	ExecResult,
	ExecutorIO,
	ImportContext,
	ImportPlan,
} from "./pipeline/types";

export class ImportExecutorService {
	constructor(
		private readonly plugin: KoreaderImporterPlugin,
		private readonly contentGen: ContentGenerator,
		private readonly mergeHandler: MergeHandler,
		private readonly noteCreation: NoteCreationService,
		private readonly fmService: FrontmatterService,
		private readonly fmGen: FrontmatterGenerator,
		private readonly log: LoggingService,
		private readonly fs: FileSystemService,
		private readonly fileNameGen: FileNameGenerator,
		private readonly snapshot: SnapshotManager,
	) {}

	private buildIO(): ExecutorIO {
		return {
			app: this.plugin.app,
			fs: this.fs,
			fmService: this.fmService,
			fmGen: this.fmGen,
			contentGen: this.contentGen,
			mergeHandler: this.mergeHandler,
			fileNameGen: this.fileNameGen,
			snapshot: this.snapshot,
			settings: this.plugin.settings,
			log: this.log,
			noteCreation: this.noteCreation,
		};
	}

	public async execute(
		plan: ImportPlan,
		ctx: ImportContext,
		session: import("src/types").DuplicateHandlingSession,
	): Promise<ExecResult> {
		// Simplified execution using NoteCreationService for CREATE and body-only provider for MERGE
		const io = this.buildIO();
		switch (plan.kind) {
			case "SKIP":
				return { status: "skipped", file: null };

			case "CREATE": {
				const file = await io.noteCreation.createFromLua(ctx.luaMetadata!);
				return { status: "created", file };
			}

			case "MERGE": {
				const result = await io.mergeHandler.handleDuplicate(
					plan.match,
					async () =>
						io.contentGen.generateHighlightsContent(
							ctx.luaMetadata?.annotations ?? [],
						),
					session,
				);
				if (result.status === "keep-both") {
					const file = await io.noteCreation.createFromLua(ctx.luaMetadata!);
					return { status: "created", file };
				}
				if (result.status === "skipped")
					return { status: "skipped", file: null };
				if (result.status === "automerged")
					return { status: "automerged", file: result.file! };
				return { status: result.status, file: result.file! } as Extract<
					ExecResult,
					{ status: "merged" | "created" }
				>;
			}

			case "AWAIT_USER_CHOICE":
				throw new Error("AWAIT_USER_CHOICE must be resolved before execution.");
		}
	}
}
