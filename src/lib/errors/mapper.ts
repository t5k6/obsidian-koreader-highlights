import type { FileSystemFailure } from "./types";

/**
 * Extracts a recognizable FS error code from various error shapes.
 * This is the canonical implementation, centralizing all heuristics.
 */
export function getFsCode(e: unknown): string | undefined {
	const maybe: any = e;
	if (typeof maybe?.code === "string") return maybe.code;

	const msg: string | undefined =
		typeof maybe?.message === "string" ? maybe.message : undefined;
	if (msg) {
		const m = msg.match(/\b(E[A-Z0-9]{2,})\b/);
		if (m) return m[1];
	}
	return undefined;
}

/**
 * Converts a raw error into a `FileSystemFailure` object for use in a `Result`.
 * This is the primary function for handling expected I/O failures gracefully.
 *
 * @param error The raw error object.
 * @param path The path associated with the operation.
 * @param defaultKind The failure kind to use if a specific one cannot be inferred.
 * @returns A structured `FileSystemFailure` object.
 */
export function toFailure(
	error: unknown,
	path: string,
	defaultKind: "ReadFailed" | "WriteFailed" = "ReadFailed",
): FileSystemFailure {
	const code = getFsCode(error);
	switch (code) {
		case "ENOENT":
			return { kind: "NotFound", path };
		case "EACCES":
		case "EPERM":
			return { kind: "PermissionDenied", path };
		case "EISDIR":
			return { kind: "IsADirectory", path };
		case "ENOTDIR":
			return { kind: "NotADirectory", path };
		case "EEXIST":
			return { kind: "AlreadyExists", path };
		case "ENAMETOOLONG":
			return { kind: "NameTooLong", path };
	}

	const message = ((error as Error)?.message ?? "").toLowerCase();
	if (message.includes("already exists"))
		return { kind: "AlreadyExists", path };
	if (
		message.includes("not found") ||
		message.includes("no such file or directory")
	)
		return { kind: "NotFound", path };
	if (
		message.includes("permission denied") ||
		message.includes("operation not permitted")
	)
		return { kind: "PermissionDenied", path };
	if (message.includes("is a directory")) return { kind: "IsADirectory", path };
	if (message.includes("not a directory"))
		return { kind: "NotADirectory", path };

	return { kind: defaultKind, path, cause: error } as FileSystemFailure;
}
