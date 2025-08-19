import { type App, Notice } from "obsidian";
import { isErr } from "src/lib/core/result";
import type { FileSystemService } from "./FileSystemService";
import type { LoggingService } from "./LoggingService";

export type Capability =
	| "pluginDataWritable"
	| "snapshotsWritable"
	| "indexPersistenceLikely";

export type CapabilityStatus = "ok" | "unavailable";

export interface CapabilityState {
	status: CapabilityStatus;
	lastChecked: number;
	ttlMs: number;
	failCount: number;
	lastError?: unknown;
}

export interface CombinedCapabilitySnapshot {
	pluginDataWritable: CapabilityState;
	snapshotsWritable: CapabilityState;
	indexPersistenceLikely: CapabilityState;

	areSnapshotsWritable: boolean;
	isPersistentIndexAvailable: boolean;
}

interface EnsureOptions {
	notifyOnce?: boolean; // show a single notice when unavailable
	forceRefresh?: boolean; // bypass TTL/backoff
}

export class CapabilityManager {
	private readonly log;
	private readonly listeners = new Set<
		(s: CombinedCapabilitySnapshot) => void
	>();
	private readonly state: Record<Capability, CapabilityState>;
	private readonly inFlight = new Map<Capability, Promise<boolean>>();
	private shownNotice: Record<Capability, boolean> = {
		pluginDataWritable: false,
		snapshotsWritable: false,
		indexPersistenceLikely: false,
	};

	// Defaults; negative caching will back off up to this cap
	private readonly BASE_TTL = 5 * 60 * 1000; // 5 minutes
	private readonly MAX_BACKOFF_TTL = 30 * 60 * 1000; // cap at 30 minutes

	constructor(
		_app: App,
		private fs: FileSystemService,
		logging: LoggingService,
	) {
		this.log = logging.scoped("CapabilityManager");

		const now = Date.now();
		const init = (ttl: number): CapabilityState => ({
			status: "unavailable",
			lastChecked: now - ttl - 1, // make stale immediately
			ttlMs: ttl,
			failCount: 0,
		});

		this.state = {
			pluginDataWritable: init(this.BASE_TTL),
			snapshotsWritable: init(this.BASE_TTL),
			indexPersistenceLikely: init(this.BASE_TTL),
		} as Record<Capability, CapabilityState>;
	}

	// Define capability requirements declaratively (relative to plugin data dir)
	private readonly capabilityConfigs: Record<
		Capability,
		{
			probePath: string;
			ensureDirs?: string[];
			dependencies?: Capability[];
		}
	> = {
		pluginDataWritable: {
			probePath: ".__plugin_probe__",
			ensureDirs: [""],
		},
		snapshotsWritable: {
			probePath: "snapshots/.__snap_probe__",
			ensureDirs: ["snapshots", "backups"],
			dependencies: ["pluginDataWritable"],
		},
		indexPersistenceLikely: {
			probePath: "highlight_index.sqlite.__probe__",
			ensureDirs: [""],
		},
	};

	// Public API

	public getSnapshot(): CombinedCapabilitySnapshot {
		const s = this.state;
		return {
			pluginDataWritable: s.pluginDataWritable,
			snapshotsWritable: s.snapshotsWritable,
			indexPersistenceLikely: s.indexPersistenceLikely,
			areSnapshotsWritable: s.snapshotsWritable.status === "ok",
			isPersistentIndexAvailable: s.indexPersistenceLikely.status === "ok",
		};
	}

	public onChange(cb: (s: CombinedCapabilitySnapshot) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	public invalidate(cap?: Capability): void {
		if (cap) {
			this.state[cap].lastChecked = 0;
		} else {
			for (const st of Object.values(this.state)) {
				st.lastChecked = 0;
			}
		}
	}

	public async ensure(
		cap: Capability,
		opts: EnsureOptions = {},
	): Promise<boolean> {
		// Handle declarative dependencies first
		const config = this.capabilityConfigs[cap];
		if (config?.dependencies?.length) {
			for (const dep of config.dependencies) {
				const ok = await this.ensure(dep, opts);
				if (!ok) return this.handleEnsureResult(cap, false, opts);
			}
		}

		if (!opts.forceRefresh && this.isFresh(cap)) {
			return this.state[cap].status === "ok";
		}
		const inFlight = this.inFlight.get(cap);
		if (inFlight) return inFlight;

		const p = this.probe(cap)
			.then((ok) => this.handleEnsureResult(cap, ok, opts))
			.finally(() => this.inFlight.delete(cap));
		this.inFlight.set(cap, p);
		return p;
	}

	public async refreshAll(force = false): Promise<CombinedCapabilitySnapshot> {
		await Promise.all([
			this.ensure("pluginDataWritable", { forceRefresh: force }),
			this.ensure("snapshotsWritable", { forceRefresh: force }),
			this.ensure("indexPersistenceLikely", { forceRefresh: force }),
		]);
		return this.getSnapshot();
	}

	// Allows services to correct the inference with real outcomes.
	// Example: LocalIndexService tried to open/persist DB and it failed.
	public reportOutcome(
		cap: Capability,
		success: boolean,
		error?: unknown,
	): void {
		const st = this.state[cap];
		st.lastChecked = Date.now();
		if (success) {
			st.status = "ok";
			st.failCount = 0;
			st.ttlMs = this.BASE_TTL;
			st.lastError = undefined;
		} else {
			st.status = "unavailable";
			st.failCount = Math.min(st.failCount + 1, 10);
			st.ttlMs = Math.min(
				this.BASE_TTL * 2 ** (st.failCount - 1),
				this.MAX_BACKOFF_TTL,
			);
			st.lastError = error;
		}
		this.emitChange();
	}

	// Convenience: run handler only if capability is available
	public async runIfCapable<T>(
		cap: Capability,
		fn: () => Promise<T>,
		opts?: EnsureOptions,
	): Promise<T | null> {
		const ok = await this.ensure(cap, opts);
		if (!ok) return null;
		return fn();
	}

	// Internals

	private isFresh(cap: Capability): boolean {
		const st = this.state[cap];
		const now = Date.now();
		return now - st.lastChecked < st.ttlMs;
	}

	private async handleEnsureResult(
		cap: Capability,
		ok: boolean,
		opts: EnsureOptions,
	): Promise<boolean> {
		this.reportOutcome(cap, ok);
		if (!ok && opts.notifyOnce && !this.shownNotice[cap]) {
			this.shownNotice[cap] = true;
			this.showNotice(cap);
		}
		return ok;
	}

	private emitChange(): void {
		const snap = this.getSnapshot();
		for (const cb of this.listeners) {
			try {
				cb(snap);
			} catch (e) {
				this.log.warn("Capability change listener threw", e);
			}
		}
	}

	private showNotice(cap: Capability): void {
		switch (cap) {
			case "snapshotsWritable":
				new Notice(
					"KOReader Importer: Snapshots & backups disabled (read-only or filesystem error).",
					8000,
				);
				this.log.warn(
					"Capability snapshotsWritable unavailable.",
					this.state[cap].lastError,
				);
				break;
			case "indexPersistenceLikely":
				new Notice(
					"KOReader Importer: Index is in-memory; duplicate detection may be slower.",
					8000,
				);
				this.log.warn(
					"Capability indexPersistenceLikely unavailable.",
					this.state[cap].lastError,
				);
				break;
			case "pluginDataWritable":
				new Notice(
					"KOReader Importer: Plugin data folder is not writable.",
					8000,
				);
				this.log.warn(
					"Capability pluginDataWritable unavailable.",
					this.state[cap].lastError,
				);
				break;
		}
	}

	private async probe(cap: Capability): Promise<boolean> {
		try {
			const config = this.capabilityConfigs[cap];
			if (!config) return false;

			// Ensure directories (relative to plugin data dir)
			if (config.ensureDirs?.length) {
				for (const dir of config.ensureDirs) {
					const fullDir = this.fs.joinPluginDataPath(dir);
					const ensured = (await this.fs.ensureVaultFolder(fullDir)) as any;
					// Be tolerant of loose mocks returning undefined; only treat as error
					// when the shape matches our Result type and isErr reports failure.
					const looksLikeResult =
						ensured && typeof ensured === "object" && "ok" in ensured;
					if (looksLikeResult && isErr(ensured)) {
						this.state[cap].lastError = ensured.error;
						return false;
					}
				}
			}

			// Write probe file
			const probePath = this.fs.joinPluginDataPath(config.probePath);
			const ok = await this.fs.writeProbe(probePath);
			this.state[cap].lastError = undefined;
			return ok;
		} catch (e) {
			// Defensive: treat unexpected probe errors as unavailable and capture error
			this.state[cap].lastError = e;
			return false;
		}
	}
}
