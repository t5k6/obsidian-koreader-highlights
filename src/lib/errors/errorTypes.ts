/** Base class for all unexpected plugin errors. */
export class PluginError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = new.target.name;
	}
}

/** Thrown when a critical service fails to initialize. */
export class InitializationError extends PluginError {}

/** Thrown for unrecoverable I/O errors not handled by Result types. */
export class CriticalIOError extends PluginError {}

/** Thrown when an operation is cancelled by the user. Useful for control flow. */
export class OperationCancelledError extends PluginError {
	constructor(message = "Operation cancelled by user.") {
		super(message);
	}
}
