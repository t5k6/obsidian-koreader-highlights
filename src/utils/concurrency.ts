export async function asyncPool<T, R>(
	poolLimit: number,
	array: readonly T[],
	iteratorFn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results: R[] = [];
	const executing = new Set<Promise<void>>();

	for (const [index, item] of array.entries()) {
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}

		const p = Promise.resolve()
			.then(() => iteratorFn(item, index))
			.then((res) => {
				results[index] = res;
			});

		executing.add(p);
		p.finally(() => executing.delete(p));

		if (executing.size >= poolLimit) {
			await Promise.race(executing);
		}
	}

	await Promise.all(executing);
	return results;
}
