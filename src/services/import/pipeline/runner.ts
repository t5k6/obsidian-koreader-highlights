import { normalizePath, TFile } from "obsidian";
import {
	FileSystemError,
	FileSystemErrorCode,
} from "src/services/FileSystemService";
import type {
	ExecResult,
	ImportContext,
	ImportIO,
	ImportPlan,
	StepOutcome,
} from "./types";

export interface Step {
	id: string;
	run(ctx: ImportContext, io: ImportIO): Promise<StepOutcome>;
}

export class ImportPipeline {
	constructor(
		private readonly steps: Step[],
		private readonly io: ImportIO,
	) {}

	async run(
		initial: ImportContext,
	): Promise<{ result: ExecResult; ctx: ImportContext }> {
		let ctx = initial;
		let plan: ImportPlan | null = null;

		for (const step of this.steps) {
			const t0 = performance.now?.() ?? Date.now();
			const out = await step.run(ctx, this.io);
			const t1 = performance.now?.() ?? Date.now();
			this.io.log.info(
				"ImportPipeline",
				`Step ${step.id} in ${(t1 - t0).toFixed(1)}ms`,
				{ metadataPath: ctx.metadataPath },
			);

			if (out.type === "continue") {
				ctx = out.ctx;
				continue;
			}
			if (out.type === "plan") {
				ctx = out.ctx;
				plan = out.plan;
				break;
			}
		}

		if (!plan) plan = { kind: "SKIP", reason: "USER_DECISION" };

		const result = await this.executePlan(plan, ctx);
		return { result, ctx };
	}

	private async executePlan(
		plan: ImportPlan,
		ctx: ImportContext,
	): Promise<ExecResult> {
		const { io } = this;

		// SKIP
		if (plan.kind === "SKIP") {
			await recordSuccess(ctx, null, io);
			return { status: "skipped", file: null };
		}

		// Build content lazily
		const contentProvider = async () => {
			const fmData = io.fmGen.createFrontmatterData(
				ctx.luaMetadata!,
				io.settings.frontmatter,
			);
			const highlights = await io.contentGen.generateHighlightsContent(
				ctx.luaMetadata!.annotations,
			);
			let content = io.fmService.reconstructFileContent(fmData, highlights);
			if (ctx.warnings.includes("duplicate-timeout")) {
				content = injectTimeoutWarning(content, io.fmService);
			}
			return content;
		};

		// CREATE
		if (plan.kind === "CREATE") {
			const res = await createNewFile(ctx, this.io, contentProvider);
			if (res.success) {
				// Deterministic snapshot without reading the vault
				const content = await contentProvider();
				await io.snapshot.createSnapshotFromContent(res.file, content);
				await afterFileWrite(ctx, res.file, this.io);
				await recordSuccess(ctx, res.file.path, this.io);
				return { status: "created", file: res.file };
			}
			await recordSuccess(ctx, null, this.io);
			return { status: "skipped", file: null };
		}

		// MERGE path via DuplicateHandler
		const r = await io.dupHandler.handleDuplicate(
			plan.match,
			contentProvider,
			plan.session,
		);
		if (r.status === "keep-both") {
			const res = await createNewFile(ctx, this.io, contentProvider, {
				collisionMode: "unique",
				promptRename: true,
			});
			if (res.success) {
				// Snapshot from known content for the newly created copy
				const content = await contentProvider();
				await io.snapshot.createSnapshotFromContent(res.file, content);
				await afterFileWrite(ctx, res.file, this.io);
				await recordSuccess(ctx, res.file.path, this.io);
				return { status: "created", file: res.file };
			}
			await recordSuccess(ctx, null, this.io);
			return { status: "skipped", file: null };
		}
		if (r.file) {
			// Apply warning post-merge if needed, then proceed with snapshot and success record
			if (ctx.warnings.includes("duplicate-timeout")) {
				const current = await io.app.vault.read(r.file);
				const mutated = injectTimeoutWarning(current, io.fmService);
				if (mutated !== current) {
					await io.app.vault.modify(r.file, mutated);
				}
			}
			// Existing file path: read with retry inside SnapshotManager
			await io.snapshot.createSnapshot(r.file);
			await afterFileWrite(ctx, r.file, this.io);
			await recordSuccess(ctx, r.file.path, this.io);
		} else {
			await recordSuccess(ctx, null, this.io);
		}
		switch (r.status) {
			case "automerged":
				return { status: "automerged", file: r.file! };
			case "merged":
				return { status: "merged", file: r.file! };
			default:
				return { status: "skipped", file: null };
		}
	}
}

// helpers reused from ImportManager, moved here for isolation
function injectTimeoutWarning(
	content: string,
	fmService: ImportIO["fmService"],
): string {
	try {
		const parsed = fmService.parseContent(content);
		const fm = parsed.frontmatter || ({} as any);
		(fm as any)["needs-review"] = "duplicate-timeout";
		const warning =
			"> [!warning] Duplicate scan did not complete\n" +
			"> The scan timed out before searching the entire vault. Review this note to avoid duplicates.\n\n";
		return fmService.reconstructFileContent(fm, warning + parsed.body);
	} catch {
		return (
			"---\nneeds-review: duplicate-timeout\n---\n\n" +
			"> [!warning] Duplicate scan did not complete\n" +
			"> The scan timed out before searching the entire vault. Review this note to avoid duplicates.\n\n" +
			content
		);
	}
}

async function createNewFile(
	ctx: ImportContext,
	io: ImportIO,
	contentProvider: () => Promise<string>,
	opts: {
		collisionMode?: "analyze" | "unique";
		promptRename?: boolean;
	} = { collisionMode: "analyze" },
): Promise<import("src/types").FileOperationResult> {
	const folder = io.settings.highlightsFolder;
	const fileNameWithExt = io.fileNameGen.generate(
		{
			useCustomTemplate: io.settings.useCustomFileNameTemplate,
			template: io.settings.fileNameTemplate,
			highlightsFolder: folder,
		},
		ctx.luaMetadata!.docProps,
		ctx.luaMetadata!.originalFilePath,
	);
	const { getFileNameWithoutExt } = await import("src/utils/formatUtils");
	const baseStem = getFileNameWithoutExt(fileNameWithExt);
	const content = await contentProvider();

	// Fast path: explicitly create a unique file, skipping duplicate analysis
	const preferUnique = opts.collisionMode === "unique";
	if (preferUnique) {
		let stem = baseStem;
		if (opts.promptRename) {
			try {
				const res = await io.ui.requestNewFileName({
					defaultStem: `${baseStem} (copy)`,
					folder,
					validate: (s) => (s && s.trim() ? null : "Filename cannot be empty"),
				});
				if ("cancelled" in res) {
					return { success: false, reason: "user_skipped" };
				}
				stem = res.stem;
			} catch {}
		}

		const file = await io.fs.createVaultFileUnique(folder, stem, content);
		return { success: true, file };
	}

	try {
		const file = await io.fs.createVaultFileSafely(folder, baseStem, content, {
			failOnFirstCollision: true,
		});
		return { success: true, file };
	} catch (err) {
		// Attempt rich duplicate handling on "already exists"
		const targetPath = normalizePath(`${folder}/${fileNameWithExt}`);
		const abs = io.app.vault.getAbstractFileByPath(targetPath);
		const isAlreadyExists =
			err instanceof FileSystemError
				? err.code === FileSystemErrorCode.AlreadyExists
				: (err as Error)?.message?.toLowerCase().includes("exists");

		if (isAlreadyExists && abs instanceof TFile) {
			const analysis = await io.dupFinder.analyzeExistingFile(
				abs,
				ctx.luaMetadata!,
			);
			const message = `A note named "${abs.name}" already exists. Choose how to proceed.`;
			const result = await io.dupHandler.handleDuplicate(
				analysis,
				async () => content,
				ctx.session,
				message,
			);

			if (result.status === "merged" || result.status === "automerged") {
				return { success: true, file: abs };
			}
			if (result.status === "keep-both") {
				let newStem = baseStem;
				try {
					const res = await io.ui.requestNewFileName({
						defaultStem: `${baseStem} (copy)`,
						folder,
						validate: (s) =>
							s && s.trim() ? null : "Filename cannot be empty",
					});
					if ("cancelled" in res) {
						return { success: false, reason: "user_skipped" };
					}
					newStem = res.stem;
				} catch {}
				const renamedFile = await io.fs.createVaultFileUnique(
					folder,
					newStem,
					content,
				);
				return { success: true, file: renamedFile };
			}
			return { success: false, reason: "user_skipped" };
		}

		// Fallback: auto-number attempt or report error
		try {
			const file = await io.fs.createVaultFileUnique(folder, baseStem, content);
			return { success: true, file };
		} catch (e) {
			return {
				success: false,
				reason: "error",
				error: e instanceof Error ? e : new Error(String(e)),
			};
		}
	}
}

async function afterFileWrite(ctx: ImportContext, file: TFile, io: ImportIO) {
	const { bookKeyFromDocProps } = await import("src/utils/formatUtils");
	await io.index.upsertBook(
		ctx.luaMetadata!.statistics?.book.id ?? null,
		bookKeyFromDocProps(ctx.luaMetadata!.docProps),
		ctx.luaMetadata!.docProps.title,
		ctx.luaMetadata!.docProps.authors,
		file.path,
	);
}

async function recordSuccess(
	ctx: ImportContext,
	vaultPath: string | null,
	io: ImportIO,
) {
	const { bookKeyFromDocProps } = await import("src/utils/formatUtils");
	await io.index.recordImportSuccess({
		path: ctx.metadataPath,
		mtime: ctx.stats?.mtimeMs ?? 0,
		size: ctx.stats?.size ?? 0,
		newestAnnotationTs: ctx.latestTs,
		bookKey: ctx.luaMetadata
			? bookKeyFromDocProps(ctx.luaMetadata.docProps)
			: null,
		md5: ctx.luaMetadata?.md5 ?? null,
		vaultPath,
	});
}
