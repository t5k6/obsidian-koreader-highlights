import type { LoggingService } from "src/services/LoggingService";
import type {
	Disposable,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import { SETTINGS_TOKEN } from "./tokens";

// A type representing any class constructor.
// T is the instance type, P is the tuple of constructor parameter types.
export type AnyClass<T = unknown, P extends any[] = any[]> = new (
	...args: P
) => T;

// A Token refers to something that resolves to an instance of T.
// For class tokens, it's `AnyClass<T, any[]>`, meaning "any class that constructs T, regardless of its specific parameter types".
// This allows a class with specific parameters (e.g., AnyClass<CacheManager, [LoggingService]>) to be used as a generic Token<CacheManager>.
export type Token<T> = AnyClass<T, any[]> | symbol;

// Internal `Registration` stores the specific constructor and its inferred parameter types.
interface Registration<T = unknown, P extends any[] = any[]> {
	class?: AnyClass<T, P>; // The actual class constructor with its specific params
	deps: Token<unknown>[]; // Dependencies are generic tokens
	isSingleton: boolean;
	factory?: (container: DIContainer, ...deps: P) => T; // Factory with resolved deps
}

function isSettingsObserver(obj: unknown): obj is SettingsObserver {
	return (
		!!obj && typeof (obj as SettingsObserver).onSettingsChanged === "function"
	);
}

function isDisposable(obj: unknown): obj is Disposable {
	return (
		!!obj &&
		typeof (obj as { dispose?: () => void | Promise<void> }).dispose ===
			"function"
	);
}

export class DIContainer {
	private readonly instances = new Map<Token<unknown>, unknown>();
	private readonly values = new Map<Token<unknown>, unknown>();
	// Store registrations with type erasure for the map, but ensure structure is compatible
	private readonly registrations = new Map<
		Token<unknown>,
		Registration<unknown, any[]>
	>();

	private readonly resolvingStack: Token<unknown>[] = [];
	private lastKnownSettings: {
		new: KoreaderHighlightImporterSettings;
		old: KoreaderHighlightImporterSettings;
	} | null = null;

	private readonly log;

	constructor(private readonly loggingService: LoggingService) {
		this.log = this.loggingService.scoped("DIContainer");
	}

	private getTokenName(token: Token<unknown>): string {
		if (typeof token === "symbol") {
			return token.description
				? `Symbol(${token.description})`
				: token.toString();
		}
		return (token as any).name;
	}

	/**
	 * Registers a class constructor with its dependencies.
	 * TypeScript infers `T` (instance type) and `P` (constructor parameter types)
	 * from the `classCtor` argument.
	 */
	public register<T, P extends any[]>(
		// The class constructor itself is used as the token.
		classCtor: AnyClass<T, P>,
		// Dependencies must be a tuple of Tokens, precisely matching the constructor's parameters.
		dependencies: { [K in keyof P]: Token<P[K]> },
		isSingleton = true,
	): this {
		const token: Token<T> = classCtor; // Valid: AnyClass<T, P> is assignable to AnyClass<T, any[]>
		if (this.registrations.has(token)) {
			this.log.warn(
				`DI registration for ${this.getTokenName(token)} is being overwritten.`,
			);
		}
		// Store the specific class constructor and its dependencies (with type erasure for the map).
		this.registrations.set(token, {
			class: classCtor,
			deps: dependencies,
			isSingleton,
		});
		return this;
	}

	/**
	 * Registers a factory function for a token. Useful for non-class tokens,
	 * external APIs, or complex instantiation logic.
	 */
	public registerFactory<T, P extends any[] = []>(
		token: Token<T>,
		factory: (container: DIContainer, ...deps: P) => T,
		dependencies: { [K in keyof P]: Token<P[K]> } = [] as any, // Default to empty array for factories without explicit deps
		isSingleton = true,
	): this {
		if (this.registrations.has(token)) {
			this.log.warn(
				`DI registration for ${this.getTokenName(token)} is being overwritten.`,
			);
		}
		this.registrations.set(token, {
			factory: factory,
			deps: dependencies,
			isSingleton,
		});
		return this;
	}

	/**
	 * Registers a pre-existing value for a given token.
	 * Useful for global objects (e.g., Obsidian's `App`) or mocked services in tests.
	 */
	public registerValue<T>(token: Token<T>, value: T): this {
		if (this.values.has(token)) {
			this.log.warn(
				`DI value for ${this.getTokenName(token)} is being overwritten.`,
			);
		}
		this.values.set(token, value);
		return this;
	}

	/**
	 * Resolves a token to its corresponding instance.
	 * Handles singletons, values, and recursively resolves dependencies.
	 */
	public resolve<T>(token: Token<T>): T {
		// Return cached singleton instance
		if (this.instances.has(token)) {
			return this.instances.get(token) as T;
		}
		// Return provided value
		if (this.values.has(token)) {
			return this.values.get(token) as T;
		}

		// Circular dependency detection
		if (this.resolvingStack.includes(token)) {
			const cyclePath = [...this.resolvingStack, token]
				.map((t) => this.getTokenName(t))
				.join(" -> ");
			throw new Error(
				`DIContainer: Circular dependency detected: ${cyclePath}`,
			);
		}
		this.resolvingStack.push(token);

		const registration = this.registrations.get(token) as
			| Registration<T>
			| undefined;
		if (!registration) {
			this.resolvingStack.pop();
			throw new Error(
				`DIContainer: Service not registered or provided as a value: ${this.getTokenName(token)}`,
			);
		}

		try {
			let instance: T;
			const resolvedDeps = registration.deps.map((depToken) =>
				this.resolve(depToken),
			);

			if (registration.factory) {
				// Invoke factory with container and resolved dependencies
				instance = registration.factory(this, ...resolvedDeps) as T;
			} else {
				const { class: classCtor } = registration; // Use `class` from registration
				if (!classCtor) {
					throw new Error(
						`DIContainer: Registration for ${this.getTokenName(
							token,
						)} has no class or factory.`,
					);
				}
				// Instantiate the class, casting the constructor to be callable with the resolved dependencies
				instance = new (classCtor as AnyClass<T, typeof resolvedDeps>)(
					...resolvedDeps,
				);
			}

			// Backfill settings for new instances if they are SettingsObservers
			if (isSettingsObserver(instance) && this.lastKnownSettings) {
				try {
					instance.onSettingsChanged(
						this.lastKnownSettings.new,
						this.lastKnownSettings.old,
					);
				} catch (error) {
					this.log.error(
						`Error notifying ${this.getTokenName(token)} of initial settings.`,
						error,
					);
				}
			}

			if (registration.isSingleton) {
				this.instances.set(token, instance);
			}
			return instance;
		} finally {
			this.resolvingStack.pop();
		}
	}

	/**
	 * Notifies all registered `SettingsObserver` instances of a settings change.
	 * Also updates the `SETTINGS_TOKEN` value if it's registered.
	 */
	public notifySettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
		oldSettings: KoreaderHighlightImporterSettings,
	): void {
		this.lastKnownSettings = { new: newSettings, old: oldSettings };

		// Also keep SETTINGS_TOKEN value current, if present
		if (this.values.has(SETTINGS_TOKEN)) {
			this.values.set(SETTINGS_TOKEN, newSettings);
		}

		let notifiedCount = 0;
		for (const instance of this.instances.values()) {
			if (isSettingsObserver(instance)) {
				try {
					instance.onSettingsChanged(newSettings, oldSettings);
					notifiedCount++;
				} catch (error) {
					this.log.error(
						`Error notifying observer ${(instance as any)?.constructor?.name ?? "<?>"} of settings change.`,
						error,
					);
				}
			}
		}
		this.log.info(`Notified ${notifiedCount} observers of settings changes.`);
	}

	/**
	 * Disposes of all registered `Disposable` instances.
	 */
	public async dispose(): Promise<void> {
		const disposals: (void | Promise<void>)[] = [];
		for (const instance of this.instances.values()) {
			if (isDisposable(instance)) {
				try {
					disposals.push(instance.dispose());
				} catch (e) {
					this.log.warn("Dispose threw synchronously for an instance.", e);
				}
			}
		}

		try {
			await Promise.all(disposals);
		} catch (error) {
			this.log.error("Error during instance disposal.", error);
		}

		this.instances.clear();
		this.registrations.clear();
		this.values.clear();
		this.log.info("All disposable instances cleared; container disposed.");
	}
}
