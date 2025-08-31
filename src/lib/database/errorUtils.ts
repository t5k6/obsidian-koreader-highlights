import { err, ok, type Result } from "../core/result";
import { getFsCode } from "../errors/mapper";
import type { AppFailure } from "../errors/types";

/**
 * Creates a standardized database operation error
 */
export function createDbError(operation: string, cause: unknown): AppFailure {
	const message = `Database operation failed: ${operation}`;
	const error = cause instanceof Error ? cause : new Error(String(cause));

	return {
		kind: "DbOperationFailed",
		operation,
		cause: error,
	};
}

/**
 * Wraps a database operation with standardized error handling
 */
export function withDbErrorHandling<T>(
	operation: string,
	fn: () => T,
): Result<T, AppFailure> {
	try {
		return ok(fn());
	} catch (e) {
		return err(DatabaseErrors.fromRaw(operation, e));
	}
}

/**
 * Wraps an async database operation with standardized error handling
 */
export async function withDbErrorHandlingAsync<T>(
	operation: string,
	fn: () => Promise<T>,
): Promise<Result<T, AppFailure>> {
	try {
		const result = await fn();
		return ok(result);
	} catch (e) {
		return err(DatabaseErrors.fromRaw(operation, e));
	}
}

/**
 * Creates a database constraint violation error
 */
export function createConstraintError(
	operation: string,
	constraint: string,
	cause?: unknown,
): AppFailure {
	const message = `Database constraint violation: ${constraint}`;
	const error = cause instanceof Error ? cause : new Error(message);

	return {
		kind: "DbPersistFailed",
		path: operation,
		cause: error,
	};
}

/**
 * Creates a database connection error
 */
export function createConnectionError(
	operation: string,
	cause?: unknown,
): AppFailure {
	const message = "Database connection failed";
	const error = cause instanceof Error ? cause : new Error(message);

	return {
		kind: "DbOpenFailed",
		path: operation,
		cause: error,
	};
}

/**
 * Creates a database validation error
 */
export function createValidationError(
	operation: string,
	cause?: unknown,
): AppFailure {
	const message = "Database validation failed";
	const error = cause instanceof Error ? cause : new Error(message);

	return {
		kind: "DbValidateFailed",
		path: operation,
		cause: error,
	};
}

/**
 * Centralized error mapping for database operations
 */
export const DatabaseErrors = {
	fromRaw(operation: string, cause: unknown): AppFailure {
		const code = getFsCode(cause);
		if (code === "EACCES") return { kind: "PermissionDenied", path: operation };
		if (code === "ENOENT") return { kind: "NotFound", path: operation };
		return createDbError(operation, cause);
	},
};
