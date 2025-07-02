import { Notice } from "obsidian";

export async function pickDirectory(): Promise<string | undefined> {
	try {
		const electron = require("electron");
		const dlg = electron.remote?.dialog;
		if (!dlg) throw new Error("electron.remote.dialog missing");

		const res = await dlg.showOpenDialog({
			properties: ["openDirectory", "dontAddToRecent"],
			title: "Select KOReader Mount Point",
		});

		if (res.canceled || res.filePaths.length === 0) return undefined;
		return res.filePaths[0];
	} catch (err) {
		console.error("KOReader-Importer: folder picker failed →", err);
		new Notice("Unable to open system file-picker. Enter the path manually.");
		return undefined;
	}
}
