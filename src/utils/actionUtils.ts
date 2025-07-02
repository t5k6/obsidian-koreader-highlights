import { type ButtonComponent, Notice } from "obsidian";
import { devError } from "./logging";

export async function runPluginAction(
	action: () => Promise<void>,
	options: {
		failureNotice: string;
		button?: ButtonComponent;
		inProgressText?: string;
		completedText?: string;
	},
): Promise<void> {
	const { button, failureNotice, inProgressText, completedText } = options;

	try {
		if (button) {
			button.setDisabled(true);
			if (inProgressText) {
				button.setButtonText(inProgressText);
			}
		}

		await action();
	} catch (error) {
		devError(failureNotice, error);
		new Notice(`${failureNotice}. Check console for details.`);
	} finally {
		if (button) {
			button.setDisabled(false);
			if (completedText) {
				button.setButtonText(completedText);
			}
		}
	}
}
