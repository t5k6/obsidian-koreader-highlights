export class LruCache<K, V> {
	constructor(
		private readonly max = 200,
		private readonly map = new Map<K, V>(),
	) {}

	get size(): number {
		return this.map.size;
	}

	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value !== undefined) {
			this.map.delete(key);
			this.map.set(key, value);
		}
		return value;
	}

	set(key: K, value: V): void {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.max) {
			const first = this.map.keys().next().value;
			if (first !== undefined) this.map.delete(first);
		}
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	/** Returns a snapshot array of current keys (from LRU-oldest to newest). */
	keys(): K[] {
		return Array.from(this.map.keys());
	}

	/** Deletes entries that match the given predicate. Returns number deleted. */
	deleteWhere(predicate: (key: K, value: V) => boolean): number {
		let removed = 0;
		for (const [k, v] of this.map.entries()) {
			if (predicate(k, v)) {
				this.map.delete(k);
				removed++;
			}
		}
		return removed;
	}
}
