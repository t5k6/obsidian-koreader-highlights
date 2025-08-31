import { QueryBuilders } from "src/services/vault/index/schema";
import { formatError } from "../errors/types";
import type { ImportSourceRow } from "./types";

export const SourceRepository = {
	// Pure query functions
	getByPath: (sourcePath: string) =>
		QueryBuilders.getImportSourceByPath(sourcePath),

	upsertSuccess: (
		sourcePath: string,
		mtime: number,
		size: number,
		newestAnnotationTs: string | null,
		bookKey?: string | null,
		md5?: string | null,
	) =>
		QueryBuilders.upsertImportSourceSuccess(
			sourcePath,
			mtime,
			size,
			newestAnnotationTs,
			Date.now(),
			bookKey ?? null,
			md5 ?? null,
		),

	upsertFailure: (sourcePath: string, error: unknown) => {
		const msg = formatError(error);
		return QueryBuilders.upsertImportSourceFailure(sourcePath, 0, 0, msg);
	},

	deleteByPath: (sourcePath: string) =>
		QueryBuilders.deleteImportSourceByPath(sourcePath),

	clearAll: () => QueryBuilders.clearAllImportSources(),

	latestSourceForBook: (bookKey: string) =>
		QueryBuilders.latestSourceForBook(bookKey),

	// Utility functions
	shouldProcess: (
		existing: ImportSourceRow | null,
		stats: { mtime: number; size: number },
		newestAnnotationTs: string | null,
		md5: string | null,
	): boolean => {
		if (!existing) return true; // Always process if it's a new source

		// If there was a previous error, always re-process
		if (existing.last_error !== null || existing.last_success_ts === null)
			return true;

		// 1. Content Hash Check (Most Reliable)
		// If both the old record and the new file have an MD5, trust it over mtime.
		if (existing.md5 && md5) {
			if (existing.md5 !== md5) {
				return true; // Content has definitively changed.
			}

			// If MD5s match, check if there are newer annotations reported.
			// This handles the edge case where highlights are added but MD5 isn't updated by KOReader (unlikely but safe).
			return !!(
				newestAnnotationTs &&
				newestAnnotationTs > (existing.newest_annotation_ts ?? "")
			);
		}
		// 2. Fallback to Filesystem Metadata (Less Reliable)
		// This path is now only taken if MD5 is not available on one or both sides.
		if (
			existing.last_processed_mtime !== stats.mtime ||
			existing.last_processed_size !== stats.size
		)
			return true;

		// 3. Final check on annotation timestamp as a last resort
		return !!(
			newestAnnotationTs &&
			newestAnnotationTs > (existing.newest_annotation_ts ?? "")
		);
	},
} as const;
