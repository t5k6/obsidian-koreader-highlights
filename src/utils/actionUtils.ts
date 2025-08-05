import type { ButtonComponent } from "obsidian";

export async function runPluginAction(
	action: () => Promise<void>,
	options: {
		button?: ButtonComponent;
		inProgressText?: string;
		completedText?: string;
	},
): Promise<void> {
	const { button, inProgressText, completedText } = options;

	const originalText = button?.buttonEl.innerText;

	try {
		if (button) {
			button.setDisabled(true);
			if (inProgressText) {
				button.setButtonText(inProgressText);
			}
		}

		await action();
	} catch (error: unknown) {
		// Re-throw the error to be handled by the caller.
		// The caller is responsible for logging and user notification.
		throw error;
	} finally {
		if (button) {
			button.setDisabled(false);
			const textToShow = completedText || originalText;
			if (textToShow) {
				button.setButtonText(textToShow);
			}
		}
	}
}
