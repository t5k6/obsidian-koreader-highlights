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

	// Provider pattern: try multiple dialog providers in order
	const providers: Array<
		() => Promise<{ canceled?: boolean; filePaths?: string[] } | undefined>
	> = [
		// Provider 1: modern window.electron
		async () => {
			const anyWindow = window as unknown as { electron?: any };
			const wElectron = anyWindow?.electron;
			if (wElectron?.showOpenDialog) {
				return await wElectron.showOpenDialog({
					properties: ["openDirectory", "dontAddToRecent"],
					title,
				});
			}
			return undefined;
		},
		// Provider 2: legacy electron.remote.dialog (sandbox fallback)
		async () => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				const electron = require("electron");
				const dlg = electron?.remote?.dialog;
				if (dlg?.showOpenDialog) {
					return await dlg.showOpenDialog({
						properties: ["openDirectory", "dontAddToRecent"],
						title,
					});
				}
			} catch {
				// require can be unavailable in sandbox – ignore
			}
			return undefined;
		},
	];

	for (const provider of providers) {
		try {
			const res = await provider();
			const dir = handleResult(res);
			if (dir) return dir;
		} catch {
			// ignore provider failure and try next
		}
	}

	// No available dialog API succeeded
	console.warn(
		"KOReader Importer: No folder picker API available (window.electron/showOpenDialog or electron.remote.dialog)",
	);
	new Notice("Folder picker is unavailable. Enter the path manually.");
	return undefined;
}
