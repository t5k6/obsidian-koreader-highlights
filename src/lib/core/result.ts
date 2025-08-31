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
 * Wraps an async operation in a Result, using an error mapper on failure.
 */
export async function wrapResult<T, E>(
	operation: () => Promise<T>,
	errorMapper: (e: unknown) => E,
): Promise<Result<T, E>> {
	try {
		return ok(await operation());
	} catch (e) {
		return err(errorMapper(e));
	}
}
