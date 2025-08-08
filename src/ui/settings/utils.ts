import { Notice } from "obsidian";

export async function pickDirectory(
	title: string,
): Promise<string | undefined> {
	try {
		// NOTE: Electron 'remote' is deprecated. Obsidian still exposes it today,
		// but this may break in a future update. If/when Obsidian provides a
		// platform API for directory picking, migrate away from electron.remote.
		const electron = require("electron");
		const dlg = electron.remote?.dialog;
		if (!dlg) throw new Error("electron.remote.dialog missing");

		const res = await dlg.showOpenDialog({
			properties: ["openDirectory", "dontAddToRecent"],
			title: title,
		});

		if (res.canceled || res.filePaths.length === 0) return undefined;
		if (res.canceled || res.filePaths.length === 0) return undefined;

		let path = res.filePaths[0];
		path = path.trim();
		if (path.length > 0) {
			path = path.replace(/\/?$/, "/"); // Add trailing slash
		}

		return path;
	} catch (err) {
		console.error("KOReader Importer: utils: folder picker failed →", err);
		new Notice("Unable to open system folder picker. Enter the path manually.");
		return undefined;
	}
}
