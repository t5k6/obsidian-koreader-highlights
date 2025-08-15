export class AsyncLazy<T> {
	private value: T | null = null;
	private init: Promise<T> | null = null;

	constructor(private readonly factory: () => Promise<T>) {}

	async get(): Promise<T> {
		if (this.value) return this.value;
		if (this.init) return this.init;

		this.init = this.factory().then(
			(v) => {
				this.value = v;
				return v; // Pass the value through
			},
			(e) => {
				// On failure, reset so the factory can be tried again later.
				this.init = null;
				throw e;
			},
		);
		return this.init;
	}

	reset(): void {
		this.value = null;
		this.init = null;
	}
}
