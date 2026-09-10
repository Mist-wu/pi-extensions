import { CdpClient, type CdpConnectOptions, type CdpWebSocketConstructor } from "./cdp-client.js";
import { type DevToolsPage, state } from "./runtime.js";

/**
 * Pooled, long-lived CDP sessions.
 *
 * The per-call `withCdp` helper opens a WebSocket, runs one command, and closes it again. That is
 * correct but has two costs: every tool call pays a fresh handshake plus its domain enables, and
 * every event produced between calls is lost, which makes event-driven domains (Network, Runtime,
 * Log) unusable across tool calls.
 *
 * A `PageSession` keeps one connection per page for as long as the Pi session owns it, remembers
 * which domains are already enabled, and records console and network activity into bounded ring
 * buffers so later tool calls can read back what happened before they ran.
 */

export const CONSOLE_BUFFER_CAPACITY = 500;
export const NETWORK_BUFFER_CAPACITY = 500;
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;

const RECORDED_DOMAINS = ["Page", "Runtime", "Log", "Network"] as const;

export interface SessionOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	webSocketConstructor?: CdpWebSocketConstructor;
}

export interface ConsoleEntry {
	kind: "console" | "exception" | "log";
	level: string;
	text: string;
	timestamp: number;
	url?: string;
	lineNumber?: number;
	stack?: string;
}

export interface NetworkEntry {
	requestId: string;
	url: string;
	method: string;
	resourceType?: string;
	status?: number;
	statusText?: string;
	mimeType?: string;
	fromCache?: boolean;
	encodedDataLength?: number;
	errorText?: string;
	startedAt: number;
	finishedAt?: number;
	durationMs?: number;
	failed?: boolean;
}

class RingBuffer<T> {
	#items: T[] = [];
	#dropped = 0;

	constructor(readonly capacity: number) {}

	get dropped() {
		return this.#dropped;
	}

	get size() {
		return this.#items.length;
	}

	push(item: T) {
		this.#items.push(item);
		while (this.#items.length > this.capacity) {
			this.#items.shift();
			this.#dropped += 1;
		}
	}

	clear() {
		this.#items = [];
		this.#dropped = 0;
	}

	toArray(): readonly T[] {
		return [...this.#items];
	}
}

export class PageSession {
	readonly console = new RingBuffer<ConsoleEntry>(CONSOLE_BUFFER_CAPACITY);
	readonly network = new RingBuffer<NetworkEntry>(NETWORK_BUFFER_CAPACITY);
	lastUsedAt = Date.now();

	readonly #enabled = new Set<string>();
	readonly #pendingRequests = new Map<string, NetworkEntry>();
	#client: CdpClient;

	constructor(
		readonly pageId: string,
		readonly webSocketDebuggerUrl: string,
		client: CdpClient,
	) {
		this.#client = client;
	}

	get client() {
		return this.#client;
	}

	get alive() {
		return !this.#client.closed;
	}

	get enabledDomains(): readonly string[] {
		return [...this.#enabled];
	}

	send<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	) {
		this.lastUsedAt = Date.now();
		return this.#client.send<T>(method, params, options);
	}

	/** Enable each domain at most once per connection, so repeat tool calls skip the round trip. */
	async ensureDomains(
		domains: readonly string[],
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	) {
		for (const domain of domains) {
			if (this.#enabled.has(domain)) continue;
			await this.#client.send(`${domain}.enable`, {}, options);
			this.#enabled.add(domain);
		}
	}

	/** Subscribe the recorders and enable the domains that feed them. */
	async startRecording(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
		this.#client.subscribe("Runtime.consoleAPICalled", (params) => {
			const entry = readConsoleApiCall(params);
			if (entry) this.console.push(entry);
		});
		this.#client.subscribe("Runtime.exceptionThrown", (params) => {
			const entry = readExceptionThrown(params);
			if (entry) this.console.push(entry);
		});
		this.#client.subscribe("Log.entryAdded", (params) => {
			const entry = readLogEntry(params);
			if (entry) this.console.push(entry);
		});
		this.#client.subscribe("Network.requestWillBeSent", (params) => this.onRequest(params));
		this.#client.subscribe("Network.responseReceived", (params) => this.onResponse(params));
		this.#client.subscribe("Network.loadingFinished", (params) => this.onFinished(params));
		this.#client.subscribe("Network.loadingFailed", (params) => this.onFailed(params));
		await this.ensureDomains(RECORDED_DOMAINS, options);
	}

	close(reason?: unknown) {
		this.#client.close(reason ?? new Error("Chrome DevTools page session closed"));
		this.#enabled.clear();
		this.#pendingRequests.clear();
	}

	private onRequest(params: unknown) {
		if (!isRecord(params)) return;
		const requestId = stringOf(params.requestId);
		const request = isRecord(params.request) ? params.request : undefined;
		if (!requestId || !request) return;
		const entry: NetworkEntry = {
			requestId,
			url: stringOf(request.url) ?? "",
			method: stringOf(request.method) ?? "GET",
			resourceType: stringOf(params.type),
			startedAt: numberOf(params.wallTime)
				? (numberOf(params.wallTime) as number) * 1000
				: Date.now(),
		};
		// A redirect reuses the requestId; retire the previous hop so both are visible.
		const previous = this.#pendingRequests.get(requestId);
		if (previous) {
			previous.finishedAt = entry.startedAt;
			previous.durationMs = Math.max(0, previous.finishedAt - previous.startedAt);
			this.network.push(previous);
		}
		this.#pendingRequests.set(requestId, entry);
		this.pruneStalePendingRequests();
	}

	private onResponse(params: unknown) {
		if (!isRecord(params)) return;
		const requestId = stringOf(params.requestId);
		const response = isRecord(params.response) ? params.response : undefined;
		if (!requestId || !response) return;
		const entry = this.#pendingRequests.get(requestId);
		if (!entry) return;
		entry.status = numberOf(response.status);
		entry.statusText = stringOf(response.statusText);
		entry.mimeType = stringOf(response.mimeType);
		entry.fromCache = response.fromDiskCache === true || response.fromPrefetchCache === true;
		if (!entry.resourceType) entry.resourceType = stringOf(params.type);
	}

	private onFinished(params: unknown) {
		if (!isRecord(params)) return;
		const requestId = stringOf(params.requestId);
		if (!requestId) return;
		const entry = this.#pendingRequests.get(requestId);
		if (!entry) return;
		this.#pendingRequests.delete(requestId);
		entry.encodedDataLength = numberOf(params.encodedDataLength);
		this.complete(entry);
	}

	private onFailed(params: unknown) {
		if (!isRecord(params)) return;
		const requestId = stringOf(params.requestId);
		if (!requestId) return;
		const entry = this.#pendingRequests.get(requestId);
		if (!entry) return;
		this.#pendingRequests.delete(requestId);
		entry.failed = true;
		entry.errorText = stringOf(params.errorText) ?? "request failed";
		this.complete(entry);
	}

	private complete(entry: NetworkEntry) {
		entry.finishedAt = Date.now();
		entry.durationMs = Math.max(0, entry.finishedAt - entry.startedAt);
		this.network.push(entry);
	}

	/**
	 * Requests that never finish (aborted navigations, long-lived streams) would otherwise pin
	 * their entry forever. Keep the pending map bounded by the same capacity as the ring.
	 */
	private pruneStalePendingRequests() {
		while (this.#pendingRequests.size > NETWORK_BUFFER_CAPACITY) {
			const oldest = this.#pendingRequests.keys().next();
			if (oldest.done) return;
			const entry = this.#pendingRequests.get(oldest.value);
			this.#pendingRequests.delete(oldest.value);
			if (entry) this.network.push(entry);
		}
	}
}

interface OwnerPool {
	sessions: Map<string, PageSession>;
	idleTimer?: ReturnType<typeof setInterval>;
}

const pools = new WeakMap<object, OwnerPool>();
const globalPool: OwnerPool = { sessions: new Map() };
const knownOwners = new Set<object>();

function poolFor(owner: object | undefined): OwnerPool {
	if (!owner) return globalPool;
	const existing = pools.get(owner);
	if (existing) return existing;
	const created: OwnerPool = { sessions: new Map() };
	pools.set(owner, created);
	knownOwners.add(owner);
	return created;
}

function scheduleIdleSweep(pool: OwnerPool) {
	if (pool.idleTimer) return;
	const timer = setInterval(() => {
		const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
		for (const [pageId, session] of pool.sessions) {
			if (session.alive && session.lastUsedAt > cutoff) continue;
			session.close(new Error("Chrome DevTools page session idle timeout"));
			pool.sessions.delete(pageId);
		}
		if (pool.sessions.size > 0) return;
		clearInterval(timer);
		pool.idleTimer = undefined;
	}, SESSION_IDLE_TIMEOUT_MS);
	// Never keep the Pi process alive just to sweep idle browser sessions.
	timer.unref?.();
	pool.idleTimer = timer;
}

/**
 * Return a live session for `page`, reusing the pooled connection when one is still open.
 * A page that was closed or navigated away reconnects transparently.
 */
export async function acquireSession(
	page: DevToolsPage,
	owner: object | undefined,
	options: SessionOptions = {},
) {
	if (!page.webSocketDebuggerUrl) {
		throw new Error(`Page has no webSocketDebuggerUrl: ${page.id}`);
	}
	const pool = poolFor(owner);
	const existing = pool.sessions.get(page.id);
	if (existing?.alive && existing.webSocketDebuggerUrl === page.webSocketDebuggerUrl) {
		existing.lastUsedAt = Date.now();
		return existing;
	}
	if (existing) {
		existing.close(new Error("Chrome DevTools page session replaced"));
		pool.sessions.delete(page.id);
	}

	const connectOptions: CdpConnectOptions = {
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		webSocketConstructor: options.webSocketConstructor,
		// A pooled connection is shared by later tool calls, so a chatty unsubscribed domain must
		// drop its backlog instead of tearing the connection down.
		eventBufferOverflow: "drop",
	};
	const client = await CdpClient.connect(page.webSocketDebuggerUrl, connectOptions);
	const session = new PageSession(page.id, page.webSocketDebuggerUrl, client);
	try {
		await session.startRecording({ signal: options.signal, timeoutMs: options.timeoutMs });
	} catch (error) {
		session.close(error);
		throw error;
	}
	pool.sessions.set(page.id, session);
	scheduleIdleSweep(pool);
	return session;
}

/** Run `callback` against a pooled session, keeping the connection open afterwards. */
export async function withSession<T>(
	page: DevToolsPage,
	owner: object | undefined,
	callback: (session: PageSession) => Promise<T>,
	options: SessionOptions = {},
) {
	const session = await acquireSession(page, owner, options);
	try {
		return await callback(session);
	} finally {
		session.lastUsedAt = Date.now();
	}
}

export function peekSession(page: DevToolsPage | string, owner: object | undefined) {
	const pageId = typeof page === "string" ? page : page.id;
	const session = poolFor(owner).sessions.get(pageId);
	return session?.alive ? session : undefined;
}

export function closeSessions(owner: object | undefined, reason?: unknown) {
	const pool = poolFor(owner);
	for (const session of pool.sessions.values()) session.close(reason);
	pool.sessions.clear();
	if (!pool.idleTimer) return;
	clearInterval(pool.idleTimer);
	pool.idleTimer = undefined;
}

/** Tear down every pooled connection; used on session replacement and extension shutdown. */
export function closeAllSessions(reason?: unknown) {
	closeSessions(undefined, reason);
	for (const owner of knownOwners) closeSessions(owner, reason);
	knownOwners.clear();
}

export function sessionPoolStatus(owner: object | undefined) {
	const pool = poolFor(owner);
	return [...pool.sessions.values()]
		.filter((session) => session.alive)
		.map((session) => ({
			pageId: session.pageId,
			domains: session.enabledDomains,
			consoleEntries: session.console.size,
			consoleDropped: session.console.dropped,
			networkEntries: session.network.size,
			networkDropped: session.network.dropped,
			idleMs: Date.now() - session.lastUsedAt,
		}));
}

function readConsoleApiCall(params: unknown): ConsoleEntry | undefined {
	if (!isRecord(params)) return undefined;
	const args = Array.isArray(params.args) ? params.args : [];
	const frame = firstStackFrame(params.stackTrace);
	return {
		kind: "console",
		level: stringOf(params.type) ?? "log",
		text: args.map(describeRemoteObject).join(" "),
		timestamp: numberOf(params.timestamp) ?? Date.now(),
		url: frame?.url,
		lineNumber: frame?.lineNumber,
	};
}

function readExceptionThrown(params: unknown): ConsoleEntry | undefined {
	if (!isRecord(params)) return undefined;
	const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : undefined;
	if (!details) return undefined;
	const exception = isRecord(details.exception) ? details.exception : undefined;
	const described = exception ? describeRemoteObject(exception) : undefined;
	return {
		kind: "exception",
		level: "error",
		text: described && described !== "undefined" ? described : (stringOf(details.text) ?? "error"),
		timestamp: numberOf(params.timestamp) ?? Date.now(),
		url: stringOf(details.url) ?? firstStackFrame(details.stackTrace)?.url,
		lineNumber: numberOf(details.lineNumber),
		stack: formatStackTrace(details.stackTrace),
	};
}

function readLogEntry(params: unknown): ConsoleEntry | undefined {
	if (!isRecord(params)) return undefined;
	const entry = isRecord(params.entry) ? params.entry : undefined;
	if (!entry) return undefined;
	const source = stringOf(entry.source) ?? "other";
	return {
		kind: "log",
		level: `${source}:${stringOf(entry.level) ?? "info"}`,
		text: stringOf(entry.text) ?? "",
		timestamp: numberOf(entry.timestamp) ?? Date.now(),
		url: stringOf(entry.url),
		lineNumber: numberOf(entry.lineNumber),
	};
}

function describeRemoteObject(value: unknown): string {
	if (!isRecord(value)) return String(value);
	if (value.unserializableValue !== undefined) return String(value.unserializableValue);
	if (value.value !== undefined) {
		return typeof value.value === "string" ? value.value : safeJson(value.value);
	}
	const description = stringOf(value.description);
	if (description) return description;
	const preview = isRecord(value.preview) ? stringOf(value.preview.description) : undefined;
	return preview ?? stringOf(value.type) ?? "undefined";
}

interface StackFrame {
	url?: string;
	lineNumber?: number;
	functionName?: string;
}

function firstStackFrame(stackTrace: unknown): StackFrame | undefined {
	if (!isRecord(stackTrace) || !Array.isArray(stackTrace.callFrames)) return undefined;
	const frame = stackTrace.callFrames[0];
	if (!isRecord(frame)) return undefined;
	return {
		url: stringOf(frame.url),
		lineNumber: numberOf(frame.lineNumber),
		functionName: stringOf(frame.functionName),
	};
}

function formatStackTrace(stackTrace: unknown): string | undefined {
	if (!isRecord(stackTrace) || !Array.isArray(stackTrace.callFrames)) return undefined;
	const frames = stackTrace.callFrames.slice(0, 10).flatMap((frame) => {
		if (!isRecord(frame)) return [];
		const name = stringOf(frame.functionName) || "<anonymous>";
		const url = stringOf(frame.url) ?? "";
		const line = numberOf(frame.lineNumber);
		const column = numberOf(frame.columnNumber);
		return [`    at ${name} (${url}:${line ?? 0}:${column ?? 0})`];
	});
	return frames.length > 0 ? frames.join("\n") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown) {
	return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeJson(value: unknown) {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Exposed for the extension lifecycle: the global (ownerless) pool used by direct tool calls. */
export function resetSessionPoolForTests() {
	closeAllSessions(new Error("test reset"));
	state.activePageId = undefined;
}
