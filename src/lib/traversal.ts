import type { TAbstractFile } from "obsidian";
import { isTFolder } from "src/lib/obsidian/typeguards";

export function* depthFirstTraverse(
	root: TAbstractFile,
	opts?: { recursive?: boolean; signal?: AbortSignal },
): Generator<TAbstractFile> {
	const recursive = opts?.recursive ?? true;
	const stack: TAbstractFile[] = [root];
	while (stack.length) {
		if (opts?.signal?.aborted) return;
		const node = stack.pop()!;
		yield node;
		if (isTFolder(node)) {
			// Add children to the stack if we are in recursive mode,
			// OR if it's a non-recursive scan and we are at the root level.
			if (recursive || node === root) {
				for (let i = node.children.length - 1; i >= 0; i--) {
					stack.push(node.children[i]!);
				}
			}
		}
	}
}
