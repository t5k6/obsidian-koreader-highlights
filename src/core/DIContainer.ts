type Ctor<T> = new (...args: any[]) => T;

export interface Disposable {
	dispose(): void | Promise<void>;
}

export class DIContainer {
	private instances = new Map<Function, any>();

	public registerSingleton<T>(token: Ctor<T>, instance: T): void {
		if (this.instances.has(token)) {
			console.warn(
				`DIContainer: Token ${token.name} is already registered. Overwriting.`,
			);
		}
		this.instances.set(token, instance);
	}

	public resolve<T>(token: Ctor<T>): T {
		const instance = this.instances.get(token);
		if (!instance) {
			throw new Error(`Service not registered: ${token.name}`);
		}
		return instance as T;
	}

	public async dispose(): Promise<void> {
		const disposalPromises: (void | Promise<void>)[] = [];
		for (const instance of this.instances.values()) {
			if (instance && typeof (instance as Disposable).dispose === "function") {
				disposalPromises.push((instance as Disposable).dispose());
			}
		}
		await Promise.all(disposalPromises);
		this.instances.clear();
	}
}
