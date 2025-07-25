export interface DebouncedFunction<T extends (...args: any[]) => any> {
	(...args: Parameters<T>): void;
	cancel(): void;
}

export function debounce(
	fn: (...args: any[]) => void,
	delay: number,
	immediate = false,
): DebouncedFunction<typeof fn> {
	let timeout: NodeJS.Timeout | null;

	const debounced = function (this: any, ...args: any[]) {
		const later = () => {
			timeout = null;
			if (!immediate) {
				fn.apply(this, args);
			}
		};

		const callNow = immediate && !timeout;

		if (timeout) {
			clearTimeout(timeout);
		}
		timeout = setTimeout(later, delay);

		if (callNow) {
			fn.apply(this, args);
		}
	};

	debounced.cancel = () => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = null;
		}
	};

	return debounced;
}
