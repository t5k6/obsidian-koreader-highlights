import { Notice, type TFile } from "obsidian";
import type { CacheManager } from "src/lib/cache/CacheManager";
import {
	convertCommentStyle,
	extractHighlightsWithStyle,
} from "src/lib/parsing/highlightExtractor";
import type KoreaderImporterPlugin from "src/main";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { CommentStyle } from "src/types";

/**
 * Maintenance operations on existing notes (non-import paths).
 * Currently supports converting all highlight files to the configured comment style.
 */
export class NoteMaintenanceService {
	private readonly log;

	constructor(
		private readonly plugin: KoreaderImporterPlugin,
		private readonly fs: FileSystemService,
		private readonly frontmatterService: FrontmatterService,
		private readonly loggingService: LoggingService,
		private readonly cacheManager: CacheManager,
	) {
		this.log = this.loggingService.scoped("NoteMaintenanceService");
	}

	/**
	 * Converts all existing highlight files to the current comment style setting.
	 * Rewrites files as needed to ensure consistency across the highlights folder.
	 */
	async convertAllFilesToCommentStyle(): Promise<void> {
		this.log.info("Starting comment style conversion for all highlight files…");

		const targetStyle = this.plugin.settings.commentStyle;
		await this.checkIfConvertingFromNone(targetStyle);

		const files = await this.getHighlightFilesToConvert();
		if (!files) return;

		const counts = { converted: 0, skipped: 0 };

		try {
			// Simple sequential or batched conversion; can parallelize if needed later
			for (const file of files) {
				await this.convertSingleFile(file, targetStyle as CommentStyle, counts);
			}

			new Notice(
				`Comment style conversion complete: ${counts.converted} files converted, ${counts.skipped} files skipped.`,
				8000,
			);
			this.log.info(
				`Comment style conversion finished - ${counts.converted} converted, ${counts.skipped} skipped`,
			);
		} catch (err: unknown) {
			if (
				typeof err === "object" &&
				err !== null &&
				(err as { name?: string }).name === "AbortError"
			) {
				new Notice("Comment style conversion cancelled by user.");
			} else {
				this.log.error("Error during comment style conversion:", err);
				new Notice(
					"Error during comment style conversion. Check console for details.",
				);
			}
		}
	}

	private async checkIfConvertingFromNone(targetStyle: string): Promise<void> {
		// Don't care if we want none anyway
		if (targetStyle === "none") return;

		const { files } = await this.fs.getFilesInFolder(
			this.plugin.settings.highlightsFolder,
			{ extensions: ["md"], recursive: false },
		);
		if (!files?.length) return;

		const sampleFiles = files.slice(0, 3); // Check first 3 files as sample

		let hasFilesWithoutComments = false;
		for (const file of sampleFiles) {
			try {
				const { body } = await this.frontmatterService.parseFile(file);
				const { annotations } = extractHighlightsWithStyle(body, "html");
				const { annotations: mdAnnotations } = extractHighlightsWithStyle(
					body,
					"md",
				);

				// If file has body content but no KOHL comments, it might be "none" style
				if (
					annotations.length === 0 &&
					mdAnnotations.length === 0 &&
					body.trim().length > 100
				) {
					hasFilesWithoutComments = true;
					break;
				}
			} catch (_error) {
				// Ignore read errors for this check
			}
		}

		if (hasFilesWithoutComments) {
			new Notice(
				`Warning: Some files appear to have no comment markers. Converting from "None" style to ${targetStyle} style cannot restore tracking information. New imports may create duplicates.`,
				8000,
			);
			this.log.warn(
				"Detected files without KOHL comments during conversion to comment style",
			);
		}
	}

	private async getHighlightFilesToConvert(): Promise<TFile[] | null> {
		const folderPath = this.plugin.settings.highlightsFolder;
		if (!folderPath) {
			new Notice("Highlights folder is not configured.");
			this.log.warn(
				"Highlights folder not configured for comment style conversion.",
			);
			return null;
		}

		const { files } = await this.fs.getFilesInFolder(folderPath, {
			extensions: ["md"],
			recursive: false,
		});

		if (files.length === 0) {
			new Notice("No markdown files found in highlights folder.");
			this.log.info("No files found to convert.");
			return null;
		}

		return files;
	}

	private async convertSingleFile(
		file: TFile,
		targetStyle: CommentStyle,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		try {
			const { frontmatter, body } =
				await this.frontmatterService.parseFile(file);

			if (targetStyle === "none") {
				await this.convertToNoneStyle(file, body, frontmatter, counts);
			} else {
				await this.convertToCommentStyle(
					file,
					body,
					frontmatter,
					targetStyle,
					counts,
				);
			}
		} catch (error) {
			this.log.error(`Error converting file ${file.path}:`, error);
			counts.skipped++;
		}
	}

	private async convertToNoneStyle(
		file: TFile,
		body: string,
		frontmatter: Record<string, unknown> | undefined,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		// Detect which KOHL comment style is used and route conversion accordingly
		const { usedStyle } = extractHighlightsWithStyle(body, "html");
		// If unsure, try both styles to ensure all markers are removed
		const newBody = usedStyle
			? convertCommentStyle(body, usedStyle, "none")
			: convertCommentStyle(
					convertCommentStyle(body, "html", "none"),
					"md",
					"none",
				);
		counts.converted++;
		this.log.info(`Removing KOHL comments from ${file.path}`);

		const newContent = this.frontmatterService.reconstructFileContent(
			frontmatter ?? {},
			newBody,
		);
		await this.fs.writeVaultFile(file.path, newContent);
	}

	private async convertToCommentStyle(
		file: TFile,
		body: string,
		frontmatter: Record<string, unknown> | undefined,
		targetStyle: CommentStyle,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		// Try to extract highlights and detect current style
		const { annotations, usedStyle } = extractHighlightsWithStyle(
			body,
			targetStyle,
		);

		if (annotations.length === 0 && body.trim().length > 100) {
			this.log.info(
				`File ${file.path} appears to have no KOHL comments - likely "none" style`,
			);
			counts.skipped++;
			return;
		}

		if (annotations.length === 0) {
			counts.skipped++;
			return;
		}

		let newBody = body;

		if (usedStyle && usedStyle !== targetStyle) {
			newBody = convertCommentStyle(body, usedStyle, targetStyle);
			counts.converted++;
			this.log.info(
				`Converting ${file.path} from ${usedStyle} to ${targetStyle} style`,
			);
		} else if (usedStyle === targetStyle) {
			// Already in the target style; don't rewrite, count as skipped for clarity
			counts.skipped++;
			this.log.info(`Skipping ${file.path} – already in ${targetStyle} style`);
			return;
		} else {
			counts.skipped++;
			return;
		}

		const newContent = this.frontmatterService.reconstructFileContent(
			frontmatter ?? {},
			newBody,
		);
		await this.fs.writeVaultFile(file.path, newContent);
	}
}
