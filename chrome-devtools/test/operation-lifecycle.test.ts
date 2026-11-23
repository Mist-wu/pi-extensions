import assert from "node:assert/strict";
import { test } from "vitest";
import {
	browserSettingsForOwner,
	setBrowserManagerOperationsForTests,
	syncManagedBrowserSettings,
} from "../src/browser-manager.js";
import { closeAllSessions, sessionPoolStatus } from "../src/cdp-session.js";
import chromeDevtools from "../src/chrome-devtools.js";
import { state } from "../src/runtime.js";
import type { EffectiveBrowserSettings } from "../src/settings.js";
import { evaluateTool } from "../src/tools.js";
import { createMockPi } from "./support.js";

function browserSettings(port: number): EffectiveBrowserSettings {
	return {
		endpoint: `http://127.0.0.1:${port}`,
		host: "127.0.0.1",
		port,
		hostConfigured: true,
		portConfigured: true,
		autoLaunchEnabled: false,
		keepAliveEnabled: false,
		extensionPaths: [],
		endpointSource: "user",
		autoLaunchSource: "user",
		executablePathSource: "default",
		userDataDirSource: "default",
		keepAliveSource: "default",
		extensionPathsSource: "default",
	};
}

function resetEndpoint(port: number) {
	state.host = "127.0.0.1";
	state.port = port;
	state.configuredPort = port;
	state.hostConfigured = true;
	state.portConfigured = true;
	state.autoLaunchEnabled = false;
	state.extensionPaths = [];
	state.browserExecutable = undefined;
	state.browserUserDataDir = undefined;
	state.keepAliveEnabled = false;
}

async function pausedList() {
	let releaseList: ((response: Response) => void) | undefined;
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const sockets: string[] = [];
	const previousWebSocket = globalThis.WebSocket;
	class RecordingSocket extends EventTarget {
		constructor(url: string | URL) {
			super();
			sockets.push(String(url));
		}
		close() {}
		send() {}
	}
	globalThis.WebSocket = RecordingSocket as unknown as typeof WebSocket;
	const restoreFetch = setBrowserManagerOperationsForTests({
		fetch: async (input) => {
			const url = String(input);
			if (url.endsWith("/json/version")) {
				return new Response(JSON.stringify({ Browser: "Chrome/149" }), { status: 200 });
			}
			if (url.endsWith("/json/list")) {
				markStarted?.();
				return new Promise<Response>((resolve) => {
					releaseList = resolve;
				});
			}
			return new Response("[]", { status: 200 });
		},
	});
	return {
		sockets,
		started,
		release() {
			releaseList?.(
				new Response(
					JSON.stringify([
						{
							id: "page-1",
							type: "page",
							title: "Late",
							url: "http://127.0.0.1/late",
							webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-1",
						},
					]),
					{ status: 200 },
				),
			);
		},
		restore() {
			restoreFetch();
			globalThis.WebSocket = previousWebSocket;
			closeAllSessions();
		},
	};
}

function toolContext(owner: object) {
	return {
		sessionManager: owner,
		ui: { setStatus() {} },
		cwd: "/tmp",
	};
}

test("a page discovery released after shutdown does not evaluate or reconnect", async () => {
	const owner = {};
	resetEndpoint(9222);
	syncManagedBrowserSettings(owner, browserSettings(9222));
	const mock = createMockPi();
	chromeDevtools(mock.pi);
	const paused = await pausedList();
	const running = evaluateTool.execute(
		"call-1",
		{ expression: "1+1" },
		undefined,
		undefined,
		toolContext(owner) as never,
	);
	try {
		await paused.started;
		await mock.events.get("session_shutdown")?.[0]?.({}, toolContext(owner));
		paused.release();
		await assert.rejects(running, /cancelled|shut down|aborted/i);
		assert.deepEqual(paused.sockets, []);
		assert.deepEqual(sessionPoolStatus(owner), []);
	} finally {
		paused.restore();
	}
});

test("a page discovery released after an endpoint change does not evaluate or reconnect", async () => {
	const owner = {};
	resetEndpoint(9222);
	syncManagedBrowserSettings(owner, browserSettings(9222));
	const paused = await pausedList();
	const running = evaluateTool.execute(
		"call-2",
		{ expression: "1+1" },
		undefined,
		undefined,
		toolContext(owner) as never,
	);
	try {
		await paused.started;
		syncManagedBrowserSettings(owner, browserSettings(9333));
		paused.release();
		await assert.rejects(running, /cancelled|endpoint changed|aborted/i);
		assert.equal(browserSettingsForOwner(owner).port, 9333);
		assert.deepEqual(paused.sockets, []);
		assert.deepEqual(sessionPoolStatus(owner), []);
	} finally {
		paused.restore();
	}
});
