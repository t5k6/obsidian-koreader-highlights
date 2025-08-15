export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export function assertNever(x: never): never {
	throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

/**
 * Unwraps a Result, returning the value if Ok, or throwing an error if Err.
 * Use sparingly in contexts where an error is considered a fatal, unrecoverable failure.
 * @param res The Result to unwrap.
 * @param context A string to prepend to the error message for better diagnostics.
 */
export function unwrap<T, E extends { kind: string }>(
	res: Result<T, E>,
	context?: string,
): T {
	if (isErr(res)) {
		const message = context
			? `${context}: Unwrapped a failed Result of kind '${res.error.kind}'`
			: `Unwrapped a failed Result of kind '${res.error.kind}'`;
		const error = new Error(message);
		// Attach the original structured error for better debugging
		(error as any).cause = res.error;
		throw error;
	}
	return res.value;
}
