import assert from "node:assert/strict";
import { test } from "vitest";
import type { CdpWebSocketConstructor } from "../src/cdp-client.js";
import {
	acquireSession,
	closeAllSessions,
	closeSessions,
	NETWORK_BUFFER_CAPACITY,
	type PageSession,
	peekSession,
	sessionPoolStatus,
	withSession,
} from "../src/cdp-session.js";
import { beginPageOperation, type DevToolsPage } from "../src/runtime.js";

const PAGE: DevToolsPage = {
	id: "page-1",
	type: "page",
	title: "Example",
	url: "https://example.com",
	webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1",
};

class FakeWebSocket extends EventTarget {
	closeCalls = 0;
	readonly sent: string[] = [];

	constructor(readonly url: string | URL) {
		super();
		// Open on the next microtask so `connect` has registered its listeners.
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}

	close(): void {
		this.closeCalls += 1;
	}

	send(payload: string): void {
		this.sent.push(payload);
		// Every command this suite issues is a domain enable or a plain command; ack them all.
		const request = JSON.parse(payload) as { id: number };
		queueMicrotask(() => this.message({ id: request.id, result: {} }));
	}

	message(payload: unknown): void {
		this.dispatchEvent(
			new MessageEvent("message", {
				data: typeof payload === "string" ? payload : JSON.stringify(payload),
			}),
		);
	}

	event(method: string, params: unknown): void {
		this.message({ method, params });
	}

	get methods() {
		return this.sent.map((payload) => (JSON.parse(payload) as { method: string }).method);
	}
}

function transport() {
	const sockets: FakeWebSocket[] = [];
	class RecordingWebSocket extends FakeWebSocket {
		constructor(url: string | URL) {
			super(url);
			sockets.push(this);
		}
	}
	return {
		sockets,
		webSocketConstructor: RecordingWebSocket as unknown as CdpWebSocketConstructor,
	};
}

async function openSession(owner: object) {
	const wire = transport();
	const session = await acquireSession(PAGE, owner, {
		webSocketConstructor: wire.webSocketConstructor,
	});
	const socket = wire.sockets[0];
	assert.ok(socket);
	return { session, socket, wire };
}

test("a new session enables the recorded domains exactly once", async () => {
	const owner = {};
	try {
		const { session, socket } = await openSession(owner);

		assert.deepEqual(socket.methods, [
			"Page.enable",
			"Runtime.enable",
			"Log.enable",
			"Network.enable",
		]);
		assert.deepEqual(session.enabledDomains, ["Page", "Runtime", "Log", "Network"]);

		// A later tool asking for the same domains must not pay for them again.
		await session.ensureDomains(["Page", "Runtime"]);
		assert.equal(socket.methods.length, 4);

		await session.ensureDomains(["Debugger"]);
		assert.deepEqual(socket.methods.at(-1), "Debugger.enable");
	} finally {
		closeAllSessions();
	}
});

test("the pool reuses one connection across calls and reconnects after a close", async () => {
	const owner = {};
	try {
		const wire = transport();
		const options = { webSocketConstructor: wire.webSocketConstructor };

		const first = await acquireSession(PAGE, owner, options);
		const second = await acquireSession(PAGE, owner, options);
		assert.equal(first, second, "expected the pooled session to be reused");
		assert.equal(wire.sockets.length, 1, "expected no second handshake");

		first.close(new Error("target crashed"));
		assert.equal(first.alive, false);
		assert.equal(peekSession(PAGE, owner), undefined);

		const third = await acquireSession(PAGE, owner, options);
		assert.notEqual(third, first, "expected a fresh session after the connection died");
		assert.equal(wire.sockets.length, 2);
		assert.equal(third.alive, true);
	} finally {
		closeAllSessions();
	}
});

test("sessions are isolated per owner and closeAllSessions tears every one down", async () => {
	const ownerA = {};
	const ownerB = {};
	try {
		const a = await openSession(ownerA);
		const b = await openSession(ownerB);
		assert.notEqual(a.session, b.session);
		assert.equal(sessionPoolStatus(ownerA).length, 1);
		assert.equal(sessionPoolStatus(ownerB).length, 1);

		closeAllSessions(new Error("session replaced"));

		assert.equal(a.session.alive, false);
		assert.equal(b.session.alive, false);
		assert.deepEqual(sessionPoolStatus(ownerA), []);
		assert.deepEqual(sessionPoolStatus(ownerB), []);
	} finally {
		closeAllSessions();
	}
});

test("console recording captures api calls, exceptions and log entries with their source", async () => {
	const owner = {};
	try {
		const { session, socket } = await openSession(owner);

		socket.event("Runtime.consoleAPICalled", {
			type: "warning",
			timestamp: 1,
			args: [
				{ type: "string", value: "cache miss for" },
				{ type: "number", value: 42 },
			],
			stackTrace: { callFrames: [{ url: "https://example.com/app.js", lineNumber: 10 }] },
		});
		socket.event("Runtime.exceptionThrown", {
			timestamp: 2,
			exceptionDetails: {
				text: "Uncaught",
				url: "https://example.com/app.js",
				lineNumber: 20,
				exception: { description: "TypeError: x is not a function" },
				stackTrace: {
					callFrames: [
						{
							functionName: "boom",
							url: "https://example.com/app.js",
							lineNumber: 20,
							columnNumber: 4,
						},
					],
				},
			},
		});
		socket.event("Log.entryAdded", {
			entry: { source: "network", level: "error", text: "404 for /missing", timestamp: 3 },
		});

		const entries = session.console.toArray();
		assert.equal(entries.length, 3);

		assert.deepEqual(
			{ ...entries[0] },
			{
				kind: "console",
				level: "warning",
				text: "cache miss for 42",
				timestamp: 1,
				url: "https://example.com/app.js",
				lineNumber: 10,
			},
		);
		assert.equal(entries[1]?.kind, "exception");
		assert.equal(entries[1]?.level, "error");
		assert.equal(entries[1]?.text, "TypeError: x is not a function");
		assert.match(entries[1]?.stack ?? "", /at boom \(https:\/\/example\.com\/app\.js:20:4\)/);
		assert.equal(entries[2]?.level, "network:error");
		assert.equal(entries[2]?.text, "404 for /missing");
	} finally {
		closeAllSessions();
	}
});

test("network recording pairs requests with responses, failures and redirects", async () => {
	const owner = {};
	try {
		const { session, socket } = await openSession(owner);

		socket.event("Network.requestWillBeSent", {
			requestId: "r1",
			wallTime: 1_700_000,
			type: "XHR",
			request: { url: "https://example.com/api", method: "POST" },
		});
		socket.event("Network.responseReceived", {
			requestId: "r1",
			response: { status: 201, statusText: "Created", mimeType: "application/json" },
		});
		socket.event("Network.loadingFinished", { requestId: "r1", encodedDataLength: 2048 });

		socket.event("Network.requestWillBeSent", {
			requestId: "r2",
			wallTime: 1_700_001,
			request: { url: "https://example.com/down", method: "GET" },
		});
		socket.event("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_FAILED" });

		// A redirect reuses the id, so the first hop must still be recorded.
		socket.event("Network.requestWillBeSent", {
			requestId: "r3",
			wallTime: 1_700_002,
			request: { url: "https://example.com/old", method: "GET" },
		});
		socket.event("Network.requestWillBeSent", {
			requestId: "r3",
			wallTime: 1_700_003,
			request: { url: "https://example.com/new", method: "GET" },
		});
		socket.event("Network.loadingFinished", { requestId: "r3", encodedDataLength: 10 });

		const entries = session.network.toArray();
		assert.deepEqual(
			entries.map((entry) => [entry.url, entry.method, entry.status ?? entry.errorText]),
			[
				["https://example.com/api", "POST", 201],
				["https://example.com/down", "GET", "net::ERR_FAILED"],
				["https://example.com/old", "GET", undefined],
				["https://example.com/new", "GET", undefined],
			],
		);
		assert.equal(entries[0]?.mimeType, "application/json");
		assert.equal(entries[0]?.encodedDataLength, 2048);
		assert.equal(entries[1]?.failed, true);
	} finally {
		closeAllSessions();
	}
});

test("a chatty page evicts the oldest records instead of killing the shared connection", async () => {
	const owner = {};
	try {
		const { session, socket } = await openSession(owner);

		const total = NETWORK_BUFFER_CAPACITY + 25;
		for (let index = 0; index < total; index += 1) {
			socket.event("Network.requestWillBeSent", {
				requestId: `r${index}`,
				wallTime: 1_700_000 + index,
				request: { url: `https://example.com/${index}`, method: "GET" },
			});
			socket.event("Network.loadingFinished", { requestId: `r${index}` });
		}

		assert.equal(session.alive, true, "a busy page must not tear down the pooled connection");
		assert.equal(session.network.size, NETWORK_BUFFER_CAPACITY);
		assert.equal(session.network.dropped, 25);
		assert.equal(session.network.toArray().at(-1)?.url, `https://example.com/${total - 1}`);

		// Unsubscribed events fall back to the bounded buffer, which must also not close the socket.
		for (let index = 0; index < 100; index += 1) {
			socket.event("Runtime.executionContextCreated", { context: { id: index } });
		}
		assert.equal(session.alive, true);
	} finally {
		closeAllSessions();
	}
});

test("withSession refreshes the idle clock and reports pool status", async () => {
	const owner = {};
	try {
		const wire = transport();
		const first = await acquireSession(PAGE, owner, {
			webSocketConstructor: wire.webSocketConstructor,
		});
		first.lastUsedAt = 0;

		const seen: PageSession[] = [];
		await withSession(PAGE, beginPageOperation(owner), async (session) => {
			seen.push(session);
		});

		assert.deepEqual(seen, [first]);
		assert.ok(first.lastUsedAt > 0, "expected withSession to refresh the idle timestamp");

		const [status] = sessionPoolStatus(owner);
		assert.equal(status?.pageId, "page-1");
		assert.deepEqual(status?.domains, ["Page", "Runtime", "Log", "Network"]);
		assert.ok((status?.idleMs ?? Number.POSITIVE_INFINITY) < 1_000);
	} finally {
		closeAllSessions();
	}
});

test("a page without a debugger URL is rejected before any connection attempt", async () => {
	const owner = {};
	const wire = transport();
	await assert.rejects(
		acquireSession({ ...PAGE, webSocketDebuggerUrl: undefined }, owner, {
			webSocketConstructor: wire.webSocketConstructor,
		}),
		/has no webSocketDebuggerUrl/,
	);
	assert.equal(wire.sockets.length, 0);
});

class GatedSocket extends EventTarget {
	static sockets: GatedSocket[] = [];
	closeCalls = 0;
	readonly sent: string[] = [];
	private openGate: () => void = () => {};

	constructor(readonly url: string | URL) {
		super();
		GatedSocket.sockets.push(this);
		this.openGate = () => this.dispatchEvent(new Event("open"));
	}

	release() {
		this.openGate();
	}

	close() {
		this.closeCalls += 1;
	}

	send(payload: string) {
		this.sent.push(payload);
		const request = JSON.parse(payload) as { id: number };
		queueMicrotask(() =>
			this.dispatchEvent(
				new MessageEvent("message", { data: JSON.stringify({ id: request.id, result: {} }) }),
			),
		);
	}
}

function gatedTransport() {
	GatedSocket.sockets = [];
	return {
		get sockets() {
			return GatedSocket.sockets;
		},
		webSocketConstructor: GatedSocket as unknown as CdpWebSocketConstructor,
	};
}

test("two callers of the same debugger address share one handshake", async () => {
	const owner = {};
	const wire = gatedTransport();
	try {
		const first = acquireSession(PAGE, owner, { webSocketConstructor: wire.webSocketConstructor });
		const second = acquireSession(PAGE, owner, { webSocketConstructor: wire.webSocketConstructor });
		assert.equal(wire.sockets.length, 1);
		wire.sockets[0]?.release();
		const [left, right] = await Promise.all([first, second]);
		assert.equal(left, right);
		assert.equal(wire.sockets.length, 1);
	} finally {
		closeAllSessions();
	}
});

test("a slower handshake for a replaced debugger url closes only itself", async () => {
	const owner = {};
	const wire = gatedTransport();
	const options = { webSocketConstructor: wire.webSocketConstructor };
	const previous = {
		...PAGE,
		webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/old",
	};
	const next = {
		...PAGE,
		webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/new",
	};
	try {
		const older = acquireSession(previous, owner, options);
		const newer = acquireSession(next, owner, options);
		const oldSocket = wire.sockets.find((socket) => String(socket.url).endsWith("/old"));
		const newSocket = wire.sockets.find((socket) => String(socket.url).endsWith("/new"));
		assert.ok(oldSocket);
		assert.ok(newSocket);
		newSocket.release();
		const session = await newer;
		oldSocket.release();
		await assert.rejects(older, /page session closed/);
		assert.equal(peekSession(next, owner), session);
		assert.equal(session.alive, true);
		assert.equal(newSocket.closeCalls, 0);
		assert.ok(oldSocket.closeCalls >= 1);
	} finally {
		closeAllSessions();
	}
});

test("cancelling one waiter leaves the shared handshake usable", async () => {
	const owner = {};
	const wire = gatedTransport();
	const caller = new AbortController();
	try {
		const cancelled = acquireSession(PAGE, owner, {
			signal: caller.signal,
			webSocketConstructor: wire.webSocketConstructor,
		});
		caller.abort(new DOMException("stop this waiter", "AbortError"));
		await assert.rejects(cancelled, (error: unknown) => {
			assert.ok(error instanceof DOMException);
			assert.equal(error.name, "AbortError");
			assert.equal(error.message, "stop this waiter");
			return true;
		});
		wire.sockets[0]?.release();
		const session = await acquireSession(PAGE, owner, {
			webSocketConstructor: wire.webSocketConstructor,
		});
		assert.equal(session.alive, true);
		assert.equal(wire.sockets.length, 1);
	} finally {
		closeAllSessions();
	}
});

test("owner shutdown discards an in-flight handshake", async () => {
	const owner = {};
	const wire = gatedTransport();
	try {
		const pending = acquireSession(PAGE, owner, {
			webSocketConstructor: wire.webSocketConstructor,
		});
		closeSessions(owner, new Error("owner shut down"));
		wire.sockets[0]?.release();
		await assert.rejects(pending);
		assert.equal(peekSession(PAGE, owner), undefined);
		assert.ok((wire.sockets[0]?.closeCalls ?? 0) >= 1);
	} finally {
		closeAllSessions();
	}
});
