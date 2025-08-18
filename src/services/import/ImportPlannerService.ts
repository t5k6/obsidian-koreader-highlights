import type { App } from "obsidian";
import type KoreaderImporterPlugin from "src/main";
import type { DeviceService } from "src/services/device/DeviceService";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import { parse as parseMetadata } from "src/services/parsing/MetadataParser";
import type { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import type { LocalIndexService } from "src/services/vault/LocalIndexService";
import {
	FastSkipStep,
	FinalSkipStep,
	ParseEnrichStep,
	ResolveActionStep,
	StatsStep,
} from "./pipeline/steps";
import type { ImportContext, ImportPlan, PlannerIO } from "./pipeline/types";

export class ImportPlannerService {
	private readonly steps: Array<
		(
			ctx: ImportContext,
			io: PlannerIO,
		) => Promise<
			| { kind: "continue"; ctx: ImportContext }
			| { kind: "decide"; ctx: ImportContext; plan: ImportPlan }
		>
	>;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly fs: FileSystemService,
		private readonly index: LocalIndexService,
		private readonly device: DeviceService,
		private readonly dupFinder: DuplicateFinder,
		private readonly log: LoggingService,
	) {
		this.steps = [
			StatsStep,
			FastSkipStep,
			ParseEnrichStep,
			FinalSkipStep,
			ResolveActionStep,
		];
	}

	private buildPlannerIO(): PlannerIO {
		return {
			fs: this.fs,
			index: this.index,
			parser: parseMetadata,
			device: this.device,
			dupFinder: this.dupFinder,
			log: this.log,
			settings: this.plugin.settings,
			app: this.app,
		};
	}

	public async plan(
		initial: ImportContext,
	): Promise<{ plan: ImportPlan; ctx: ImportContext }> {
		const io = this.buildPlannerIO();
		let ctx = initial;
		let decided: ImportPlan | null = null;

		for (const step of this.steps) {
			const t0 = (globalThis as any).performance?.now?.() ?? Date.now();
			const out = await step(ctx, io);
			const t1 = (globalThis as any).performance?.now?.() ?? Date.now();
			io.log?.info?.(
				`[ImportPlanner] step in ${(t1 - t0).toFixed(1)}ms — ${ctx.metadataPath}`,
			);

			if (out.kind === "continue") {
				ctx = out.ctx;
				continue;
			}
			if (out.kind === "decide") {
				ctx = out.ctx;
				decided = out.plan;
				break;
			}
		}

		const plan =
			decided ?? ({ kind: "SKIP", reason: "USER_DECISION" } as const);
		return { plan, ctx };
	}
}
