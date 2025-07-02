/**
 * Manages the open/closed state of <details> elements between re-renders.
 */
export class SectionStateManager {
	private state = new Map<string, boolean>();

	saveState(container: HTMLElement): void {
		this.state.clear();
		container.querySelectorAll("details").forEach((details) => {
			if (details.dataset.title) {
				this.state.set(details.dataset.title, details.open);
			}
		});
	}

	restoreState(container: HTMLElement): void {
		container.querySelectorAll("details").forEach((details) => {
			const title = details.dataset.title;
			if (title && this.state.has(title)) {
				details.open = this.state.get(title) ?? false;
			}
		});
	}
}
