import { setIcon } from "obsidian";

/**
 * ModalContentBuilder: helper for building rich modal content with consistent semantics/styles.
 * Stateless; operates on a provided container element.
 */
export class ModalContentBuilder {
	constructor(private container: HTMLElement) {}

	/**
	 * Adds a status header with optional icon and badge.
	 */
	addStatusHeader(config: {
		title: string;
		badge?: { type: string; label: string };
		icon?: string;
		headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
		containerClass?: string;
	}): this {
		const header = this.container.createDiv("modal-status-header");
		if (config.containerClass) header.addClass(config.containerClass);
		if (config.icon) setIcon(header.createSpan("modal-icon"), config.icon);
		const level = config.headingLevel ?? 2;
		header.createEl(`h${level}` as any, { text: config.title });
		if (config.badge) {
			const badge = header.createEl("span", {
				cls: "badge",
				text: config.badge.label,
			});
			(badge as HTMLElement).dataset.type = config.badge.type;
		}
		return this;
	}

	/**
	 * Adds a file path row with file icon and optional click handler.
	 */
	addFilePath(
		path: string,
		onClick?: () => void,
		containerClass?: string,
	): this {
		const pathLine = this.container.createDiv("modal-file-path");
		if (containerClass) pathLine.addClass(containerClass);
		setIcon(pathLine.createSpan(), "file-text");
		const pathEl = pathLine.createSpan({ text: path });
		if (onClick) {
			pathEl.addClass("mod-clickable");
			(pathEl as HTMLElement).onclick = onClick;
		}
		return this;
	}

	/**
	 * Adds a titled list of stats, where items may be typed (data-change-type).
	 */
	addStatsList(
		title: string,
		items: Array<{ text: string; type?: "add" | "modify" | "info" }>,
		containerClass?: string,
	): this {
		const section = this.container.createDiv("modal-stats");
		if (containerClass) section.addClass(containerClass);
		section.createEl("h4", { text: title });
		const list = section.createEl("ul");
		for (const item of items) {
			const li = list.createEl("li", { text: item.text });
			if (item.type) (li as HTMLElement).dataset.changeType = item.type;
		}
		return this;
	}
}
