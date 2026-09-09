import assert from "node:assert/strict";
import { test } from "vitest";
import {
	formatBytes,
	formatConsoleEntry,
	formatNetworkEntry,
	formatSnapshot,
	matchesLevel,
	matchesRequest,
	parseKeyChord,
	resolveDeviceMetrics,
} from "../src/advanced-tools.js";
import type { ConsoleEntry, NetworkEntry } from "../src/cdp-session.js";
import {
	focusAndClearScript,
	resolveElementScript,
	snapshotScript,
	waitConditionScript,
} from "../src/page-scripts.js";

const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;

test("key chords map to CDP fields and only send text when they are text entry", () => {
	assert.deepEqual(parseKeyChord("Enter"), {
		key: "Enter",
		code: "Enter",
		keyCode: 13,
		modifiers: 0,
		text: "\r",
	});

	assert.deepEqual(parseKeyChord("a"), {
		key: "a",
		code: "KeyA",
		keyCode: 65,
		modifiers: 0,
		text: "a",
	});

	// A shortcut must not also insert the character, or Control+a types an "a".
	const selectAll = parseKeyChord("Control+a");
	assert.equal(selectAll.modifiers, CONTROL);
	assert.equal(selectAll.text, undefined);

	// Shift alone is still text entry.
	assert.equal(parseKeyChord("Shift+a").text, "a");
	assert.equal(parseKeyChord("Shift+a").modifiers, SHIFT);

	assert.equal(parseKeyChord("Cmd+Alt+Escape").modifiers, META | ALT);
	assert.equal(parseKeyChord("ctrl+shift+Tab").modifiers, CONTROL | SHIFT);
	assert.equal(parseKeyChord("arrowdown").key, "ArrowDown", "key names are case-insensitive");
	assert.equal(parseKeyChord("ArrowDown").code, "ArrowDown");
	assert.equal(parseKeyChord("Space").text, " ");
	assert.equal(parseKeyChord("7").code, "Digit7");
});

test("key chords reject unknown modifiers and unsupported key names", () => {
	assert.throws(() => parseKeyChord("Hyper+a"), /Unknown modifier "Hyper"/);
	assert.throws(() => parseKeyChord("F13"), /Unsupported key "F13"/);
	assert.throws(() => parseKeyChord("+"), /Could not parse key chord/);
});

test("device emulation resolves presets and lets explicit values win", () => {
	assert.deepEqual(resolveDeviceMetrics({ device: "iphone" }), {
		width: 393,
		height: 852,
		deviceScaleFactor: 3,
		mobile: true,
	});
	assert.deepEqual(resolveDeviceMetrics({ device: "desktop", width: 1024 }), {
		width: 1024,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	assert.deepEqual(resolveDeviceMetrics({ width: 800, height: 600 }), {
		width: 800,
		height: 600,
		deviceScaleFactor: 1,
		mobile: false,
	});
	// Nothing to apply: the caller must fall through to another override or an error.
	assert.equal(resolveDeviceMetrics({ width: 800 }), undefined);
	assert.equal(resolveDeviceMetrics({}), undefined);
});

test("console filtering treats exceptions as errors and matches log sources", () => {
	const entry = (level: string, kind: ConsoleEntry["kind"] = "console"): ConsoleEntry => ({
		kind,
		level,
		text: "message",
		timestamp: 1,
	});

	assert.equal(matchesLevel(entry("log"), "all"), true);
	assert.equal(matchesLevel(entry("error"), "error"), true);
	assert.equal(matchesLevel(entry("network:error"), "error"), true);
	assert.equal(matchesLevel(entry("verbose", "exception"), "error"), true);
	assert.equal(matchesLevel(entry("warning"), "warning"), true);
	assert.equal(matchesLevel(entry("warning"), "error"), false);
	assert.equal(matchesLevel(entry("log"), "info"), true);
	assert.equal(matchesLevel(entry("error"), "info"), false);
});

test("network filtering combines url, method and failure predicates", () => {
	const base: NetworkEntry = {
		requestId: "r1",
		url: "https://example.com/api/users",
		method: "GET",
		startedAt: 0,
	};
	const ok = { ...base, status: 200 };
	const notFound = { ...base, status: 404 };
	const failed = { ...base, failed: true, errorText: "net::ERR_FAILED" };

	assert.equal(matchesRequest(ok, { urlContains: "/api/" }), true);
	assert.equal(matchesRequest(ok, { urlContains: "/static/" }), false);
	assert.equal(matchesRequest(ok, { method: "get" }), true, "method match is case-insensitive");
	assert.equal(matchesRequest(ok, { method: "POST" }), false);
	assert.equal(matchesRequest(ok, { failedOnly: true }), false);
	assert.equal(matchesRequest(notFound, { failedOnly: true }), true);
	assert.equal(matchesRequest(failed, { failedOnly: true }), true);
	assert.equal(matchesRequest(notFound, { failedOnly: true, method: "POST" }), false);
});

test("snapshot rendering keeps refs, state and targets on one line each", () => {
	const rendered = formatSnapshot({
		url: "https://example.com/login",
		title: "Sign in",
		total: 3,
		truncated: true,
		nodes: [
			{ ref: "e1", role: "textbox", name: "Email", selector: "#email", value: "a@b.c" },
			{ ref: "e2", role: "checkbox", name: "Remember me", selector: "#remember", state: "checked" },
			{ ref: "e3", role: "link", name: "Forgot?", selector: "a:nth-of-type(2)", href: "/reset" },
		],
	});
	const lines = rendered.split("\n");

	assert.equal(lines[0], "Sign in — https://example.com/login");
	assert.equal(lines[1], "3 of 3 elements (truncated)");
	assert.equal(lines[2], 'e1 textbox "Email" value="a@b.c" (#email)');
	assert.equal(lines[3], 'e2 checkbox "Remember me" [checked] (#remember)');
	assert.equal(lines[4], 'e3 link "Forgot?" -> /reset (a:nth-of-type(2))');
});

test("console and network entries render compactly with location and size", () => {
	assert.equal(
		formatConsoleEntry({
			kind: "console",
			level: "error",
			text: "boom",
			timestamp: 1,
			url: "https://example.com/a.js",
			lineNumber: 12,
		}),
		"[error] boom https://example.com/a.js:12",
	);

	assert.equal(
		formatNetworkEntry({
			requestId: "r1",
			url: "https://example.com/api",
			method: "POST",
			status: 201,
			durationMs: 34.6,
			encodedDataLength: 2048,
			resourceType: "XHR",
			startedAt: 0,
		}),
		"POST 201 35ms 2.0KB XHR https://example.com/api (id=r1)",
	);

	assert.match(
		formatNetworkEntry({
			requestId: "r2",
			url: "https://example.com/x",
			method: "GET",
			failed: true,
			errorText: "net::ERR_FAILED",
			startedAt: 0,
		}),
		/^GET FAILED net::ERR_FAILED /,
	);

	assert.equal(formatBytes(512), "512B");
	assert.equal(formatBytes(2048), "2.0KB");
	assert.equal(formatBytes(3 * 1024 * 1024), "3.0MB");
});

test("snapshot script honours its limit and heading toggle", () => {
	const withHeadings = snapshotScript(25, true);
	assert.match(withHeadings, /all\.slice\(0, 25\)/);
	assert.match(withHeadings, /INTERACTIVE \+ ', ' \+ STRUCTURAL/);
	assert.match(withHeadings, /truncated: all\.length > 25/);

	const withoutHeadings = snapshotScript(10, false);
	assert.match(withoutHeadings, /const selector = INTERACTIVE;/);
	assert.doesNotMatch(withoutHeadings, /STRUCTURAL;/);
});

test("element lookup scripts embed refs and selectors as JSON literals", () => {
	const byRef = resolveElementScript({ ref: "e12" });
	assert.match(byRef, /registry\.map\.get\("e12"\)/);
	assert.match(byRef, /scrollIntoView/);
	assert.match(byRef, /Take a fresh chrome_devtools_snapshot/);

	// A selector containing quotes must not be able to break out of the script.
	const bySelector = resolveElementScript({ selector: 'a[title="x"]' });
	assert.match(bySelector, /document\.querySelector\("a\[title=\\"x\\"\]"\)/);

	const focusing = focusAndClearScript({ selector: "#email" }, true);
	assert.match(focusing, /document\.querySelector\("#email"\)/);
	assert.match(focusing, /if \(true\) \{/);
	assert.match(focusing, /focused: document\.activeElement === el/);

	assert.match(focusAndClearScript({ ref: "e1" }, false), /if \(false\) \{/);
});

test("wait conditions cover selectors, text, expressions and their negations", () => {
	assert.equal(
		waitConditionScript({ selector: ".ready" }),
		'(() => Boolean(document.querySelector(".ready")))()',
	);
	assert.equal(
		waitConditionScript({ selector: ".spinner", gone: true }),
		'(() => !Boolean(document.querySelector(".spinner")))()',
	);
	assert.match(waitConditionScript({ text: "Welcome" }), /includes\("Welcome"\)/);
	assert.match(
		waitConditionScript({ text: "Loading", gone: true }),
		/^\(\(\) => !\(document\.body/,
	);
	assert.equal(
		waitConditionScript({ expression: "window.ready === true" }),
		"(() => Boolean(window.ready === true))()",
	);
	// An expression wins over the other forms so callers get exactly what they asked for.
	assert.match(waitConditionScript({ expression: "x", selector: ".y" }), /Boolean\(x\)/);
});
