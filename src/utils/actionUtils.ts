// Minimal interface so callers can provide a ButtonComponent or a lightweight shim
interface ButtonLike {
	setDisabled: (disabled: boolean) => void;
	setButtonText: (text: string) => void;
	// Optional, only present on Obsidian's ButtonComponent
	buttonEl?: HTMLElement;
}

export async function runPluginAction(
	action: () => Promise<void>,
	options: {
		button?: ButtonLike;
		inProgressText?: string;
		completedText?: string;
	},
): Promise<void> {
	const { button, inProgressText, completedText } = options;

	const originalText = button?.buttonEl ? button.buttonEl.innerText : undefined;

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
			const textToShow = completedText ?? originalText;
			if (textToShow !== undefined) {
				button.setButtonText(textToShow);
			}
		}
	}
}
