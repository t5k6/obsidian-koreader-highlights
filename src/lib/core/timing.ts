/**
 * Provides timing utilities for performance measurements and diagnostics.
 */

/**
 * Wraps an async function with timing measurement and logging.
 * Returns the function result while logging timing information.
 *
 * @param name - A descriptive name for the operation being timed
 * @param fn - The async function to execute and time
 * @param diagnostics - Optional array to push timing diagnostics to
 * @returns The result of the wrapped function
 */
export async function timed<T>(
	name: string,
	fn: () => Promise<T>,
	diagnostics?: Array<{ severity: string; message: string }>,
): Promise<T> {
	const t0 = performance?.now?.() ?? Date.now();
	const out = await fn();
	const t1 = performance?.now?.() ?? Date.now();

	const message = `[${name}] ${(t1 - t0).toFixed(1)}ms`;

	if (diagnostics) {
		diagnostics.push({
			severity: "info",
			message,
		});
	}

	return out;
}
