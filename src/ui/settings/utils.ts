import { Notice } from "obsidian";
import { FileSystemService } from "src/services/FileSystemService";

export async function pickDirectory(
	title: string,
): Promise<string | undefined> {
	// Normalize picked system path using shared utility, then ensure trailing slash
	const normalizePickedDir = (p: string): string => {
		const sys = FileSystemService.normalizeSystemPath(p ?? "");
		return sys ? `${sys}/` : "";
	};

	// Common handler for Electron dialog results
	const handleResult = (
		res: { canceled?: boolean; filePaths?: string[] } | undefined,
	): string | undefined => {
		if (!res || res.canceled || !res.filePaths || res.filePaths.length === 0)
			return undefined;
		return normalizePickedDir(res.filePaths[0]);
	};

	try {
		// Preferred: Obsidian's modern exposed electron API on window
		const anyWindow = window as unknown as { electron?: any };
		const wElectron = anyWindow?.electron;
		if (wElectron?.showOpenDialog) {
			const res = await wElectron.showOpenDialog({
				properties: ["openDirectory", "dontAddToRecent"],
				title,
			});
			return handleResult(res);
		}

		// Fallback: legacy electron.remote.dialog (deprecated in modern Electron)
		// Kept for backward compatibility with older Obsidian versions.
		let dlg: any | undefined;
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const electron = require("electron");
			dlg = electron?.remote?.dialog;
		} catch (_e) {
			// require may be unavailable in sandboxed contexts
		}

		if (dlg?.showOpenDialog) {
			const res = await dlg.showOpenDialog({
				properties: ["openDirectory", "dontAddToRecent"],
				title,
			});
			return handleResult(res);
		}

		// No available dialog API
		console.warn(
			"KOReader Importer: No folder picker API available (window.electron/showOpenDialog or electron.remote.dialog)",
		);
		new Notice(
			"Folder picker is unavailable in this environment. Enter the path manually.",
		);
		return undefined;
	} catch (err) {
		console.error("KOReader Importer: utils: folder picker failed →", err);
		new Notice("Unable to open system folder picker. Enter the path manually.");
		return undefined;
	}
}
