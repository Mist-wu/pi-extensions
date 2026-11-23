/**
 * Wait for a shared operation without letting one caller's cancellation abort the others.
 * The caller receives their own abort reason, the abort listener is removed on settle, and the
 * shared promise keeps running for whoever else is still waiting.
 */
export function waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => settle(() => reject(signal.reason));
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => settle(() => resolve(value)),
			(error) => settle(() => reject(error)),
		);
	});
}
