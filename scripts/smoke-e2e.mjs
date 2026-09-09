// End-to-end smoke test against a real Chrome, driving the extension's own modules.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERE = path.join(ROOT, "test", "smoke");
const jiti = createJiti(path.join(ROOT, "scripts/smoke-e2e.mjs"), { interopDefault: true });

const { acquireSession, closeAllSessions } = await jiti.import(
	path.join(ROOT, "src/cdp-session.ts"),
);
const { snapshotScript, resolveElementScript, focusAndClearScript, waitConditionScript } =
	await jiti.import(path.join(ROOT, "src/page-scripts.ts"));
const { parseKeyChord, formatSnapshot, formatConsoleEntry, formatNetworkEntry } = await jiti.import(
	path.join(ROOT, "src/advanced-tools.ts"),
);

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serve the fixture so Network events have a real origin.
const html = readFileSync(path.join(HERE, "fixture.html"), "utf8");
const server = createServer((req, res) => {
	if (req.url === "/") {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(html);
		return;
	}
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/`;

const profile = mkdtempSync(path.join(os.tmpdir(), "pi-cdp-smoke-"));

let cleanedUp = false;
function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	try {
		chrome?.kill("SIGKILL");
	} catch {}
	try {
		server.close();
	} catch {}
	rmSync(profile, { recursive: true, force: true });
}
// A crash or an interrupt must not leave a headless Chrome and its profile behind.
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		cleanup();
		process.exit(130);
	});
}
process.on("uncaughtException", (error) => {
	console.error(error);
	cleanup();
	process.exit(1);
});
const chrome = spawn(
	process.env.PI_CHROME_DEVTOOLS_BROWSER ??
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	[
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		pageUrl,
	],
	{ stdio: "ignore" },
);

// Chrome writes the port it actually bound into the profile directory.
async function debuggerPort() {
	const portFile = path.join(profile, "DevToolsActivePort");
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (existsSync(portFile)) {
			const first = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
			if (first) return Number(first);
		}
		await sleep(250);
	}
	throw new Error("Chrome never reported a debugging port");
}

async function devtools(pathname) {
	const debugPort = await debuggerPort();
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${debugPort}${pathname}`);
			if (response.ok) return response.json();
		} catch {}
		await sleep(250);
	}
	throw new Error(`DevTools endpoint never came up for ${pathname}`);
}

const owner = {};
try {
	await devtools("/json/version");
	let pages = [];
	for (let attempt = 0; attempt < 40; attempt += 1) {
		pages = (await devtools("/json/list")).filter(
			(p) => p.type === "page" && p.webSocketDebuggerUrl && p.url.startsWith("http://127.0.0.1"),
		);
		if (pages.length > 0) break;
		await sleep(250);
	}
	const page = pages[0];
	if (!page) throw new Error("no inspectable page");
	check("chrome exposes the fixture page", true, page.url);

	const session = await acquireSession(page, owner);
	check(
		"pooled session connects and enables domains",
		session.alive,
		session.enabledDomains.join(","),
	);

	const again = await acquireSession(page, owner);
	check("second acquire reuses the same connection", again === session);

	const evaluate = async (expression) => {
		const out = await session.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (out.exceptionDetails) {
			throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
		}
		return out.result?.value;
	};

	// Reload through the pooled session so the recorders see the whole page load.
	await session.send("Page.navigate", { url: pageUrl });
	await sleep(1200);

	// --- snapshot ---
	const snapshot = await evaluate(snapshotScript(120, true));
	const rendered = formatSnapshot(snapshot);
	const emailNode = snapshot.nodes.find((n) => n.selector === "#email");
	const buttonNode = snapshot.nodes.find((n) => n.selector === "#counter");
	const linkNode = snapshot.nodes.find((n) => n.selector === "#forgot");
	const checkboxNode = snapshot.nodes.find((n) => n.selector === "#chk");
	check(
		"snapshot finds the labelled text field",
		emailNode?.role === "textbox" && emailNode?.name === "Email address",
		JSON.stringify(emailNode),
	);
	check("snapshot reads the current field value", emailNode?.value === "prefilled");
	check("snapshot records link targets", linkNode?.href === "/reset", linkNode?.href);
	check(
		"snapshot reports checkbox state",
		checkboxNode?.state?.includes("checked") === true,
		checkboxNode?.state,
	);
	check(
		"snapshot includes the h1 heading",
		snapshot.nodes.some((n) => n.role === "heading" && n.name === "Smoke Test"),
	);
	check(
		"snapshot renders one line per node",
		rendered.split("\n").length === snapshot.nodes.length + 2,
	);

	// --- click by ref, with real Input events ---
	const target = await evaluate(resolveElementScript({ ref: buttonNode.ref }));
	check(
		"ref resolves to a viewport box",
		target.width > 0 && target.height > 0,
		`${Math.round(target.x)},${Math.round(target.y)} ${target.tag}`,
	);

	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
		await session.send("Input.dispatchMouseEvent", {
			type,
			x: target.x,
			y: target.y,
			button: type === "mouseMoved" ? "none" : "left",
			clickCount: type === "mouseMoved" ? 0 : 1,
			buttons: type === "mousePressed" ? 1 : 0,
		});
	}
	await sleep(150);
	const clicks = await evaluate("window.__clicks || 0");
	check("real mouse events reach the page handler", clicks === 1, `clicks=${clicks}`);
	// isTrusted is the whole point of dispatching through Input rather than scripting a click:
	// arm the listener first, then click again and read what the page saw.
	await evaluate(
		"window.__trusted = new Promise((r) => document.getElementById('counter').addEventListener('click', (e) => r(e.isTrusted), { once: true })); true",
	);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await session.send("Input.dispatchMouseEvent", {
			type,
			x: target.x,
			y: target.y,
			button: "left",
			clickCount: 1,
			buttons: type === "mousePressed" ? 1 : 0,
		});
	}
	const isTrusted = await evaluate("window.__trusted");
	check(
		"the page sees the click as a trusted user event",
		isTrusted === true,
		`isTrusted=${isTrusted}`,
	);

	// --- fill ---
	const focused = await evaluate(focusAndClearScript({ ref: emailNode.ref }, true));
	check("focus and clear targets the field", focused.focused === true && focused.tag === "input");
	await session.send("Input.insertText", { text: "smoke@test.dev" });
	const typed = await evaluate("document.getElementById('email').value");
	check("insertText replaces the cleared value", typed === "smoke@test.dev", typed);

	// --- press Enter to submit ---
	const enter = parseKeyChord("Enter");
	const common = {
		key: enter.key,
		code: enter.code,
		windowsVirtualKeyCode: enter.keyCode,
		nativeVirtualKeyCode: enter.keyCode,
		modifiers: enter.modifiers,
	};
	await session.send("Input.dispatchKeyEvent", { ...common, type: "keyDown", text: enter.text });
	await session.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" });
	await sleep(200);
	const submitted = await evaluate("document.getElementById('out').textContent");
	check("Enter submits the form", submitted === "submitted:smoke@test.dev", submitted);

	// --- Control+a must select, not type an "a" ---
	await evaluate(focusAndClearScript({ ref: emailNode.ref }, true));
	await session.send("Input.insertText", { text: "abc" });
	const selectAll = parseKeyChord("Control+a");
	const sa = {
		key: selectAll.key,
		code: selectAll.code,
		windowsVirtualKeyCode: selectAll.keyCode,
		nativeVirtualKeyCode: selectAll.keyCode,
		modifiers: selectAll.modifiers,
	};
	await session.send("Input.dispatchKeyEvent", { ...sa, type: "rawKeyDown" });
	await session.send("Input.dispatchKeyEvent", { ...sa, type: "keyUp" });
	const afterChord = await evaluate("document.getElementById('email').value");
	check("Control+a does not insert a character", afterChord === "abc", afterChord);

	// --- wait_for ---
	const waitScript = waitConditionScript({ selector: "#late" });
	check("wait condition evaluates to a boolean", typeof (await evaluate(waitScript)) === "boolean");
	const goneScript = waitConditionScript({ selector: "#nonexistent", gone: true });
	check("negated wait condition is true when absent", (await evaluate(goneScript)) === true);
	const textScript = waitConditionScript({ text: "Smoke Test" });
	check("text wait condition matches body text", (await evaluate(textScript)) === true);

	// --- console recording ---
	const consoleEntries = session.console.toArray();
	const warning = consoleEntries.find((e) => e.text.includes("boot warning"));
	const exception = consoleEntries.find((e) => e.kind === "exception");
	check(
		"console recorder captured the page warning",
		Boolean(warning),
		warning && formatConsoleEntry(warning),
	);
	check("console recorder captured the uncaught exception", Boolean(exception), exception?.text);
	// Chrome only sends exceptionDetails.stackTrace for some throw sites, but the description it
	// does send already carries the frames, so assert on what the agent actually reads.
	const located = `${exception?.stack ?? ""}${exception?.text ?? ""}`;
	check(
		"exception reports a source location",
		/:\d+:\d+/.test(located),
		located.split("\n")[1]?.trim(),
	);
	check("exception records the throwing url", Boolean(exception?.url), exception?.url);

	// --- network recording ---
	const requests = session.network.toArray();
	const document_ = requests.find((r) => r.url === pageUrl);
	const missing = requests.find((r) => r.url.includes("/missing-endpoint"));
	check(
		"network recorder captured the document request",
		document_?.status === 200,
		document_ && formatNetworkEntry(document_),
	);
	check(
		"network recorder captured the 404",
		missing?.status === 404,
		missing && formatNetworkEntry(missing),
	);
	check("network entries carry durations", typeof document_?.durationMs === "number");

	// --- response body by request id ---
	if (missing) {
		const body = await session.send("Network.getResponseBody", { requestId: missing.requestId });
		check(
			"response body is retrievable by recorded request id",
			body.body === "nope",
			JSON.stringify(body.body),
		);
	}

	// --- emulate ---
	await session.send("Emulation.setDeviceMetricsOverride", {
		width: 393,
		height: 852,
		deviceScaleFactor: 3,
		mobile: true,
	});
	const viewport = await evaluate("innerWidth + 'x' + innerHeight");
	check("mobile device metrics override applies", viewport === "393x852", viewport);
	await session.send("Emulation.setDeviceMetricsOverride", {
		width: 800,
		height: 600,
		deviceScaleFactor: 1,
		mobile: false,
	});
	const desktop = await evaluate("innerWidth + 'x' + innerHeight");
	check("desktop device metrics override applies", desktop === "800x600", desktop);
	await session.send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-color-scheme", value: "dark" }],
	});
	const dark = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches");
	check("colour scheme emulation applies", dark === true);
	await session.send("Emulation.clearDeviceMetricsOverride");

	// --- raw CDP escape hatch ---
	await session.send("Debugger.enable");
	await session.ensureDomains(["Debugger"]);
	check(
		"raw CDP can enable a domain the tools do not wrap",
		session.enabledDomains.includes("Debugger"),
		session.enabledDomains.join(","),
	);
	const cookies = await session.send("Network.getCookies");
	check("raw CDP returns structured results", Array.isArray(cookies.cookies));

	// --- chatty page does not kill the pooled connection ---
	await evaluate("for (let i=0;i<40;i++) fetch('/missing-endpoint').catch(()=>{}); true");
	await sleep(800);
	check(
		"connection survives a burst of network activity",
		session.alive,
		`${session.network.size} recorded, ${session.network.dropped} dropped`,
	);
} catch (error) {
	check("smoke run completed", false, String(error?.stack ?? error));
} finally {
	closeAllSessions();
	cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
