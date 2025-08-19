import type { LoggingService } from "src/services/LoggingService";
import type {
	Disposable,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import { SETTINGS_TOKEN } from "./tokens";

export type Ctor<T> = new (...args: any[]) => T;
export type Token<T> = Ctor<T> | symbol;

interface Registration {
	ctor: Ctor<unknown>;
	deps: Token<unknown>[];
	isSingleton: boolean;
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
	private instances = new Map<Token<unknown>, unknown>();
	private values = new Map<Token<unknown>, unknown>();
	private registrations = new Map<Token<unknown>, Registration>();
	private resolvingStack: Token<unknown>[] = [];
	private lastKnownSettings: {
		new: KoreaderHighlightImporterSettings;
		old: KoreaderHighlightImporterSettings;
	} | null = null;
	private readonly log;

	constructor(private loggingService: LoggingService) {
		this.log = this.loggingService.scoped("DIContainer");
	}

	private getTokenName(token: Token<unknown>): string {
		return typeof token === "symbol" ? token.toString() : token.name;
	}

	public register<T>(
		ctor: Ctor<T>,
		dependencies: Token<unknown>[],
		isSingleton = true,
	): this {
		const token = ctor as Token<T>;
		if (this.registrations.has(token)) {
			this.log.warn(
				`DI registration for ${this.getTokenName(token)} is being overwritten.`,
			);
		}
		this.registrations.set(token, {
			ctor,
			deps: dependencies,
			isSingleton,
		});
		return this;
	}

	public registerValue<T>(token: Token<T>, value: T): this {
		if (this.values.has(token)) {
			this.log.warn(
				`DI value for ${this.getTokenName(token)} is being overwritten.`,
			);
		}
		this.values.set(token, value);
		return this;
	}

	public resolve<T>(token: Token<T>): T {
		if (this.instances.has(token)) {
			return this.instances.get(token) as T;
		}
		if (this.values.has(token)) {
			return this.values.get(token) as T;
		}

		if (this.resolvingStack.includes(token)) {
			const cyclePath = [...this.resolvingStack, token]
				.map((t) => this.getTokenName(t))
				.join(" -> ");
			throw new Error(
				`DIContainer: Circular dependency detected: ${cyclePath}`,
			);
		}
		this.resolvingStack.push(token);

		const registration = this.registrations.get(token);
		if (!registration) {
			this.resolvingStack.pop();
			throw new Error(
				`DIContainer: Service not registered or provided as a value: ${this.getTokenName(
					token,
				)}`,
			);
		}

		try {
			const resolvedDependencies = registration.deps.map((depToken) =>
				this.resolve(depToken),
			);
			const newInstance = new registration.ctor(...resolvedDependencies);

			if (this.lastKnownSettings && isSettingsObserver(newInstance)) {
				newInstance.onSettingsChanged(
					this.lastKnownSettings.new,
					this.lastKnownSettings.old,
				);
			}

			if (registration.isSingleton) {
				this.instances.set(token, newInstance);
			}

			return newInstance as T;
		} finally {
			this.resolvingStack.pop();
		}
	}

	public notifySettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
		oldSettings: KoreaderHighlightImporterSettings,
	): void {
		this.lastKnownSettings = { new: newSettings, old: oldSettings };

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
						`Error notifying observer ${instance.constructor.name} of settings change.`,
						error,
					);
				}
			}
		}
		this.log.info(`Notified ${notifiedCount} observers of settings changes.`);
	}

	public async dispose(): Promise<void> {
		const disposalPromises: (void | Promise<void>)[] = [];
		for (const instance of this.instances.values()) {
			if (isDisposable(instance)) {
				disposalPromises.push(instance.dispose());
			}
		}

		await Promise.all(disposalPromises).catch((error) => {
			this.log.error("Error during instance disposal.", error);
		});

		this.instances.clear();
		this.registrations.clear();
		this.values.clear();

		this.log.info(
			"All disposable instances have been cleared and container is disposed.",
		);
	}
}
