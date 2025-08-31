import type { Annotation } from "src/types";
import { isWithinGap } from "./formatUtils";

export interface SuccessiveGroup {
	annotations: Annotation[];
	separators: (" " | " [...] ")[];
}

/**
 * Groups successive highlights based on a maximum gap threshold.
 * Pure and side-effect free.
 */
export function groupSuccessiveHighlights(
	anno: Annotation[],
	maxHighlightGap: number,
): SuccessiveGroup[] {
	const groups: SuccessiveGroup[] = [];
	let current: Annotation[] = [];
	let seps: (" " | " [...] ")[] = [];

	for (let i = 0; i < anno.length; i++) {
		const h = anno[i];

		if (current.length) {
			const prev = current[current.length - 1];
			seps.push(isWithinGap(prev, h, maxHighlightGap) ? " " : " [...] ");
		}

		current.push(h);

		const next = anno[i + 1];
		if (!next || !isWithinGap(h, next, maxHighlightGap)) {
			groups.push({ annotations: current, separators: seps });
			current = [];
			seps = [];
		}
	}
	return groups;
}
