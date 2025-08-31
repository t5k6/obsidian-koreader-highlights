import type { Vault } from "obsidian";
import { readWithRetry } from "src/lib/concurrency/retry";
import { sha1HexOfBuffer } from "src/lib/core/crypto";
import { err, ok, type Result } from "src/lib/core/result";
import type { AppFailure } from "src/lib/errors/types";

/**
 * Reads a file from the adapter and verifies its content equals the expected ArrayBuffer.
 * Stateless; suitable for use anywhere.
 */
export async function verifyWrittenFile(
	adapter: Vault["adapter"],
	path: string,
	expected: ArrayBuffer,
): Promise<Result<void, AppFailure>> {
	try {
		const written = await readWithRetry(adapter, path, {
			maxAttempts: 3,
			baseDelayMs: 20,
		});
		const [expHashResult, gotHashResult] = await Promise.all([
			sha1HexOfBuffer(expected),
			sha1HexOfBuffer(written),
		]);
		if (!expHashResult.ok) {
			return err({
				kind: "WriteFailed",
				path,
				cause: expHashResult.error,
			});
		}
		if (!gotHashResult.ok) {
			return err({
				kind: "WriteFailed",
				path,
				cause: gotHashResult.error,
			});
		}
		if (expHashResult.value !== gotHashResult.value) {
			return err({
				kind: "WriteFailed",
				path,
				cause: new Error("Checksum mismatch"),
			});
		}
		return ok(void 0);
	} catch (e) {
		return err({ kind: "ReadFailed", path, cause: e });
	}
}
