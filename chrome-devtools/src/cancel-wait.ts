import { setTimeout as delay } from "node:timers/promises";

/**
 * Wait for a shared operation without letting one caller's cancellation abort the others.
 * The caller receives their own abort reason, the abort listener is removed on settle, and the
 * shared promise keeps running for whoever else is still waiting.
 */
export function waitForCaller<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export async function abortableSleep(ms: number, signal?: AbortSignal) {
	try {
		await delay(ms, undefined, { signal });
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}
}
