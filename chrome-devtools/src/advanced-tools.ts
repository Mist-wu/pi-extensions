import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatPage, resolvePage, textResult } from "./cdp-client.js";
import {
	type ConsoleEntry,
	type NetworkEntry,
	type PageSession,
	withSession,
} from "./cdp-session.js";
import {
	focusAndClearScript,
	type ResolvedElement,
	resolveElementScript,
	type SnapshotResult,
	snapshotScript,
	waitConditionScript,
} from "./page-scripts.js";
import { renderTextResult, renderToolCall, withStatus } from "./render.js";
import { CHROME_DEVTOOLS_TOOL_NAMES } from "./tool-names.js";

const MAX_BODY_CHARS = 20_000;
const DEFAULT_SNAPSHOT_LIMIT = 120;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_INTERVAL_MS = 100;

interface ToolContext {
	sessionManager: object;
	ui: { setStatus: (key: string, value: string | undefined) => void };
}

const pageIdParameter = Type.Optional(
	Type.String({ description: "Optional page id. Defaults to selected or first page." }),
);

/** Evaluate an expression in the page and return its serialized value, surfacing page throws. */
async function evaluateJson<T>(
	session: PageSession,
	expression: string,
	options: { signal?: AbortSignal; awaitPromise?: boolean } = {},
) {
	const outcome = await session.send<{
		result?: { value?: unknown };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	}>(
		"Runtime.evaluate",
		{
			expression,
			returnByValue: true,
			awaitPromise: options.awaitPromise ?? true,
		},
		{ signal: options.signal },
	);
	if (outcome.exceptionDetails) {
		const description =
			outcome.exceptionDetails.exception?.description ??
			outcome.exceptionDetails.text ??
			"page evaluation failed";
		throw new Error(description);
	}
	return outcome.result?.value as T;
}

async function onPage<T>(
	ctx: ToolContext,
	pageId: string | undefined,
	signal: AbortSignal | undefined,
	callback: (session: PageSession, page: ReturnType<typeof formatPage>) => Promise<T>,
) {
	const page = await resolvePage(pageId, { sessionOwner: ctx.sessionManager, signal });
	return withSession(page, ctx.sessionManager, (session) => callback(session, formatPage(page)), {
		signal,
	});
}

export const snapshotTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[5],
	label: "Chrome DevTools: Snapshot",
	description:
		"Capture a compact text outline of the page's interactive elements with stable refs. Far cheaper than a screenshot and the refs can be passed to chrome_devtools_click and chrome_devtools_fill.",
	parameters: Type.Object({
		pageId: pageIdParameter,
		limit: Type.Optional(
			Type.Integer({
				description: `Maximum elements to include. Defaults to ${DEFAULT_SNAPSHOT_LIMIT}.`,
				minimum: 1,
				maximum: 500,
			}),
		),
		includeHeadings: Type.Optional(
			Type.Boolean({ description: "Include h1-h6 headings for structure. Defaults to true." }),
		),
	}),
	renderCall: renderToolCall("snapshot"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "snapshot", async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const snapshot = await evaluateJson<SnapshotResult>(
					session,
					snapshotScript(params.limit ?? DEFAULT_SNAPSHOT_LIMIT, params.includeHeadings ?? true),
					{ signal },
				);
				return textResult(formatSnapshot(snapshot), { page, snapshot });
			}),
		);
	},
});

export const clickTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[6],
	label: "Chrome DevTools: Click",
	description:
		"Dispatch a real mouse event at an element or coordinate. Unlike a scripted dispatchEvent these are trusted browser input events, so pages cannot tell them apart from a user.",
	parameters: Type.Object({
		ref: Type.Optional(Type.String({ description: "Element ref from chrome_devtools_snapshot." })),
		selector: Type.Optional(Type.String({ description: "CSS selector, used when ref is absent." })),
		x: Type.Optional(
			Type.Number({ description: "Viewport X, used when ref and selector absent." }),
		),
		y: Type.Optional(
			Type.Number({ description: "Viewport Y, used when ref and selector absent." }),
		),
		action: Type.Optional(
			Type.Union(
				[
					Type.Literal("click"),
					Type.Literal("doubleClick"),
					Type.Literal("rightClick"),
					Type.Literal("hover"),
				],
				{ description: "Interaction to perform. Defaults to click." },
			),
		),
		pageId: pageIdParameter,
	}),
	renderCall: renderToolCall("click"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const action = params.action ?? "click";
		return withStatus(ctx, action, async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const target = await locate(session, params, signal);
				const base = { x: target.x, y: target.y, signal };

				if (action === "hover") {
					await dispatchMouse(session, { ...base, type: "mouseMoved", button: "none" });
					return textResult(`Hovered ${describeTarget(params, target)}`, { page, target });
				}

				const button = action === "rightClick" ? "right" : "left";
				await dispatchMouse(session, { ...base, type: "mouseMoved", button: "none" });
				const clicks = action === "doubleClick" ? 2 : 1;
				for (let clickCount = 1; clickCount <= clicks; clickCount += 1) {
					await dispatchMouse(session, { ...base, type: "mousePressed", button, clickCount });
					await dispatchMouse(session, { ...base, type: "mouseReleased", button, clickCount });
				}
				return textResult(`${action} on ${describeTarget(params, target)}`, { page, target });
			}),
		);
	},
});

export const fillTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[7],
	label: "Chrome DevTools: Fill",
	description:
		"Focus a form field and type text into it with real input events, optionally clearing it first and submitting afterwards.",
	parameters: Type.Object({
		text: Type.String({ description: "Text to type into the field.", maxLength: 10_000 }),
		ref: Type.Optional(Type.String({ description: "Element ref from chrome_devtools_snapshot." })),
		selector: Type.Optional(Type.String({ description: "CSS selector, used when ref is absent." })),
		clear: Type.Optional(
			Type.Boolean({ description: "Clear the field before typing. Defaults to true." }),
		),
		submit: Type.Optional(
			Type.Boolean({ description: "Press Enter after typing. Defaults to false." }),
		),
		pageId: pageIdParameter,
	}),
	renderCall: renderToolCall("fill"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		if (!params.ref && !params.selector) {
			throw new Error("chrome_devtools_fill requires either ref or selector.");
		}
		return withStatus(ctx, "fill", async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const focused = await evaluateJson<{ tag: string; focused: boolean }>(
					session,
					focusAndClearScript(params, params.clear ?? true),
					{ signal },
				);
				if (!focused.focused) {
					throw new Error(
						`Could not focus ${describeSelectorOrRef(params)}; it may be disabled or covered.`,
					);
				}
				await session.send("Input.insertText", { text: params.text }, { signal });
				if (params.submit) await pressKey(session, "Enter", signal);
				const suffix = params.submit ? " and submitted" : "";
				return textResult(
					`Typed ${params.text.length} characters into ${describeSelectorOrRef(params)}${suffix}`,
					{ page, tag: focused.tag, submitted: params.submit === true },
				);
			}),
		);
	},
});

export const pressTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[8],
	label: "Chrome DevTools: Press Key",
	description:
		'Send real keyboard events to the focused element. Accepts a key name such as "Enter", "Tab" or "ArrowDown", optionally with modifiers such as "Control+a".',
	parameters: Type.Object({
		keys: Type.String({
			description: 'Key or chord, e.g. "Enter", "Escape", "Control+a", "Shift+Tab".',
			maxLength: 100,
		}),
		repeat: Type.Optional(
			Type.Integer({ description: "Times to repeat. Defaults to 1.", minimum: 1, maximum: 50 }),
		),
		pageId: pageIdParameter,
	}),
	renderCall: renderToolCall("press"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "press", async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const times = params.repeat ?? 1;
				for (let index = 0; index < times; index += 1) {
					await pressKey(session, params.keys, signal);
				}
				return textResult(`Pressed ${params.keys}${times > 1 ? ` x${times}` : ""}`, { page });
			}),
		);
	},
});

export const waitForTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[9],
	label: "Chrome DevTools: Wait For",
	description:
		"Wait until a selector appears or disappears, text is present, or a JavaScript expression becomes truthy. Use this instead of guessing at sleeps after a navigation or click.",
	parameters: Type.Object({
		selector: Type.Optional(Type.String({ description: "CSS selector to wait for." })),
		text: Type.Optional(Type.String({ description: "Visible body text to wait for." })),
		expression: Type.Optional(
			Type.String({ description: "JavaScript expression that should become truthy." }),
		),
		gone: Type.Optional(
			Type.Boolean({
				description: "Wait for the selector or text to disappear instead. Defaults to false.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Integer({
				description: `Maximum wait. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}.`,
				minimum: 100,
				maximum: 120_000,
			}),
		),
		pageId: pageIdParameter,
	}),
	renderCall: renderToolCall("wait"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		if (!params.selector && !params.text && !params.expression) {
			throw new Error("chrome_devtools_wait_for requires selector, text, or expression.");
		}
		const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		return withStatus(ctx, "wait", async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const script = waitConditionScript(params);
				const deadline = Date.now() + timeoutMs;
				let polls = 0;
				while (Date.now() < deadline) {
					signal?.throwIfAborted();
					polls += 1;
					// A navigation mid-wait invalidates the execution context; retry rather than fail.
					const satisfied = await evaluateJson<boolean>(session, script, { signal }).catch(
						() => false,
					);
					if (satisfied) {
						return textResult(`Condition met after ${polls} checks`, {
							page,
							polls,
							timedOut: false,
						});
					}
					await delay(WAIT_POLL_INTERVAL_MS, signal);
				}
				throw new Error(
					`Timed out after ${timeoutMs}ms waiting for ${describeCondition(params)}. The page may not have reached that state.`,
				);
			}),
		);
	},
});

export const consoleTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[10],
	label: "Chrome DevTools: Console",
	description:
		"Read console messages and uncaught exceptions recorded on the page. Recording starts when the page session opens, so this returns messages from before this call.",
	parameters: Type.Object({
		pageId: pageIdParameter,
		level: Type.Optional(
			Type.Union(
				[Type.Literal("all"), Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")],
				{ description: "Filter by severity. Defaults to all." },
			),
		),
		limit: Type.Optional(
			Type.Integer({
				description: "Maximum entries, newest last. Defaults to 100.",
				minimum: 1,
				maximum: 500,
			}),
		),
		clear: Type.Optional(
			Type.Boolean({ description: "Clear the buffer after reading. Defaults to false." }),
		),
	}),
	renderCall: renderToolCall("console"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "console", async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const level = params.level ?? "all";
				const limit = params.limit ?? 100;
				const all = session.console.toArray();
				const filtered = all.filter((entry) => matchesLevel(entry, level));
				const entries = filtered.slice(-limit);
				const dropped = session.console.dropped;
				if (params.clear) session.console.clear();
				const header =
					entries.length === 0
						? `No console entries${level === "all" ? "" : ` at level ${level}`}.`
						: `${entries.length} console ${entries.length === 1 ? "entry" : "entries"}${
								filtered.length > entries.length ? ` (of ${filtered.length})` : ""
							}${dropped > 0 ? `; ${dropped} older dropped` : ""}:`;
				const body = entries.map(formatConsoleEntry).join("\n");
				return textResult([header, body].filter(Boolean).join("\n"), {
					page,
					entries,
					dropped,
				});
			}),
		);
	},
});

export const networkTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[11],
	label: "Chrome DevTools: Network",
	description:
		"List network requests recorded on the page, optionally filtered, and fetch one response body by request id. Recording starts when the page session opens.",
	parameters: Type.Object({
		pageId: pageIdParameter,
		urlContains: Type.Optional(
			Type.String({ description: "Only requests whose URL contains this." }),
		),
		method: Type.Optional(Type.String({ description: "Only this HTTP method, e.g. POST." })),
		failedOnly: Type.Optional(
			Type.Boolean({ description: "Only failed requests and 4xx/5xx responses." }),
		),
		limit: Type.Optional(
			Type.Integer({
				description: "Maximum entries, newest last. Defaults to 50.",
				minimum: 1,
				maximum: 500,
			}),
		),
		bodyForRequestId: Type.Optional(
			Type.String({
				description:
					"Return the response body for this recorded request id instead of the list. Bodies are only retained by Chrome for a limited time.",
			}),
		),
	}),
	renderCall: renderToolCall("network"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "network", async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				if (params.bodyForRequestId) {
					const body = await session.send<{ body: string; base64Encoded: boolean }>(
						"Network.getResponseBody",
						{ requestId: params.bodyForRequestId },
						{ signal },
					);
					const truncated = body.body.length > MAX_BODY_CHARS;
					const text = truncated ? `${body.body.slice(0, MAX_BODY_CHARS)}\n…truncated` : body.body;
					return textResult(text, {
						page,
						requestId: params.bodyForRequestId,
						base64Encoded: body.base64Encoded,
						truncated,
					});
				}

				const limit = params.limit ?? 50;
				const all = session.network.toArray();
				const filtered = all.filter((entry) => matchesRequest(entry, params));
				const entries = filtered.slice(-limit);
				const dropped = session.network.dropped;
				const header =
					entries.length === 0
						? "No matching network requests recorded."
						: `${entries.length} request${entries.length === 1 ? "" : "s"}${
								filtered.length > entries.length ? ` (of ${filtered.length})` : ""
							}${dropped > 0 ? `; ${dropped} older dropped` : ""}:`;
				const body = entries.map(formatNetworkEntry).join("\n");
				return textResult([header, body].filter(Boolean).join("\n"), { page, entries, dropped });
			}),
		);
	},
});

export const emulateTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[12],
	label: "Chrome DevTools: Emulate",
	description:
		"Emulate a device viewport, user agent, colour scheme, network speed, or CPU slowdown, so responsive and performance behaviour can be checked without a real device.",
	parameters: Type.Object({
		pageId: pageIdParameter,
		device: Type.Optional(
			Type.Union(
				[
					Type.Literal("iphone"),
					Type.Literal("pixel"),
					Type.Literal("ipad"),
					Type.Literal("desktop"),
				],
				{ description: "Viewport preset. Overridden by explicit width/height." },
			),
		),
		width: Type.Optional(Type.Integer({ minimum: 100, maximum: 5_000 })),
		height: Type.Optional(Type.Integer({ minimum: 100, maximum: 5_000 })),
		deviceScaleFactor: Type.Optional(Type.Number({ minimum: 0.1, maximum: 5 })),
		mobile: Type.Optional(Type.Boolean()),
		userAgent: Type.Optional(Type.String({ maxLength: 500 })),
		colorScheme: Type.Optional(
			Type.Union([Type.Literal("light"), Type.Literal("dark")], {
				description: "Emulate prefers-color-scheme.",
			}),
		),
		network: Type.Optional(
			Type.Union(
				[
					Type.Literal("offline"),
					Type.Literal("slow-3g"),
					Type.Literal("fast-3g"),
					Type.Literal("none"),
				],
				{ description: "Network throttling preset." },
			),
		),
		cpuThrottlingRate: Type.Optional(
			Type.Number({
				description: "CPU slowdown multiplier; 1 is no throttling.",
				minimum: 1,
				maximum: 20,
			}),
		),
		reset: Type.Optional(
			Type.Boolean({ description: "Clear every emulation override instead of applying one." }),
		),
	}),
	renderCall: renderToolCall("emulate"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, "emulate", async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const applied: string[] = [];
				if (params.reset) {
					await session.send("Emulation.clearDeviceMetricsOverride", {}, { signal });
					await session.send("Emulation.setCPUThrottlingRate", { rate: 1 }, { signal });
					await session.send("Emulation.setEmulatedMedia", { features: [] }, { signal });
					await session.send(
						"Network.emulateNetworkConditions",
						NETWORK_PRESETS.none as unknown as Record<string, unknown>,
						{ signal },
					);
					return textResult("Cleared all emulation overrides", { page, reset: true });
				}

				const metrics = resolveDeviceMetrics(params);
				if (metrics) {
					await session.send("Emulation.setDeviceMetricsOverride", metrics, { signal });
					applied.push(`viewport ${metrics.width}x${metrics.height}@${metrics.deviceScaleFactor}x`);
				}
				if (params.userAgent) {
					await session.send(
						"Emulation.setUserAgentOverride",
						{ userAgent: params.userAgent },
						{ signal },
					);
					applied.push("user agent");
				}
				if (params.colorScheme) {
					await session.send(
						"Emulation.setEmulatedMedia",
						{ features: [{ name: "prefers-color-scheme", value: params.colorScheme }] },
						{ signal },
					);
					applied.push(`prefers-color-scheme: ${params.colorScheme}`);
				}
				if (params.network) {
					await session.send(
						"Network.emulateNetworkConditions",
						NETWORK_PRESETS[params.network] as unknown as Record<string, unknown>,
						{ signal },
					);
					applied.push(`network ${params.network}`);
				}
				if (params.cpuThrottlingRate !== undefined) {
					await session.send(
						"Emulation.setCPUThrottlingRate",
						{ rate: params.cpuThrottlingRate },
						{ signal },
					);
					applied.push(`cpu ${params.cpuThrottlingRate}x slowdown`);
				}
				if (applied.length === 0) {
					throw new Error(
						"chrome_devtools_emulate needs at least one override, or reset: true to clear them.",
					);
				}
				return textResult(`Applied ${applied.join(", ")}`, { page, applied });
			}),
		);
	},
});

export const cdpSendTool = defineTool({
	name: CHROME_DEVTOOLS_TOOL_NAMES[13],
	label: "Chrome DevTools: Raw CDP",
	description:
		"Send any Chrome DevTools Protocol command to the page and return its raw result. This is the escape hatch for domains the dedicated tools do not cover, such as Debugger, Profiler, Storage, Accessibility and Fetch.",
	promptGuidelines: [
		"Prefer a dedicated chrome_devtools_* tool when one covers the task; use chrome_devtools_cdp_send for protocol domains they do not expose.",
		"Enable a domain before using its commands, for example Debugger.enable before Debugger.setBreakpointByUrl.",
	],
	parameters: Type.Object({
		method: Type.String({
			description: 'CDP method, e.g. "Debugger.enable" or "Storage.clearDataForOrigin".',
			maxLength: 200,
		}),
		params: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), { description: "Command parameters." }),
		),
		pageId: pageIdParameter,
	}),
	renderCall: renderToolCall("cdp"),
	renderResult: renderTextResult,
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		return withStatus(ctx, `cdp ${params.method}`, async () =>
			onPage(ctx, params.pageId, signal, async (session, page) => {
				const result = await session.send(params.method, params.params ?? {}, { signal });
				// Track domain enables so pooled sessions do not re-enable them on later calls.
				const enable = params.method.match(/^([A-Za-z]+)\.enable$/);
				if (enable?.[1]) await session.ensureDomains([enable[1]], { signal });
				const text = JSON.stringify(result, null, 2) ?? "null";
				const truncated = text.length > MAX_BODY_CHARS;
				return textResult(truncated ? `${text.slice(0, MAX_BODY_CHARS)}\n…truncated` : text, {
					page,
					method: params.method,
					result,
				});
			}),
		);
	},
});

const NETWORK_PRESETS = {
	offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
	"slow-3g": {
		offline: false,
		latency: 400,
		downloadThroughput: (500 * 1024) / 8,
		uploadThroughput: (500 * 1024) / 8,
	},
	"fast-3g": {
		offline: false,
		latency: 150,
		downloadThroughput: (1.6 * 1024 * 1024) / 8,
		uploadThroughput: (750 * 1024) / 8,
	},
	none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
} as const;

const DEVICE_PRESETS = {
	iphone: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
	pixel: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true },
	ipad: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
	desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
} as const;

export function resolveDeviceMetrics(params: {
	device?: keyof typeof DEVICE_PRESETS;
	width?: number;
	height?: number;
	deviceScaleFactor?: number;
	mobile?: boolean;
}) {
	const preset = params.device ? DEVICE_PRESETS[params.device] : undefined;
	const width = params.width ?? preset?.width;
	const height = params.height ?? preset?.height;
	if (width === undefined || height === undefined) return undefined;
	return {
		width,
		height,
		deviceScaleFactor: params.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1,
		mobile: params.mobile ?? preset?.mobile ?? false,
	};
}

async function locate(
	session: PageSession,
	params: { ref?: string; selector?: string; x?: number; y?: number },
	signal: AbortSignal | undefined,
): Promise<ResolvedElement> {
	if (params.ref || params.selector) {
		return evaluateJson<ResolvedElement>(session, resolveElementScript(params), { signal });
	}
	if (params.x === undefined || params.y === undefined) {
		throw new Error("Provide ref, selector, or both x and y.");
	}
	return {
		x: params.x,
		y: params.y,
		width: 0,
		height: 0,
		tag: "point",
		selector: `(${params.x}, ${params.y})`,
		name: "",
	};
}

async function dispatchMouse(
	session: PageSession,
	options: {
		type: string;
		x: number;
		y: number;
		button: string;
		clickCount?: number;
		signal?: AbortSignal;
	},
) {
	await session.send(
		"Input.dispatchMouseEvent",
		{
			type: options.type,
			x: options.x,
			y: options.y,
			button: options.button,
			clickCount: options.clickCount ?? 0,
			buttons: options.type === "mousePressed" ? mouseButtonMask(options.button) : 0,
		},
		{ signal: options.signal },
	);
}

function mouseButtonMask(button: string) {
	if (button === "right") return 2;
	if (button === "middle") return 4;
	return button === "none" ? 0 : 1;
}

const MODIFIER_BITS: Record<string, number> = {
	alt: 1,
	control: 2,
	ctrl: 2,
	meta: 4,
	cmd: 4,
	command: 4,
	shift: 8,
};

interface KeyDefinition {
	code: string;
	keyCode: number;
	text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
	Enter: { code: "Enter", keyCode: 13, text: "\r" },
	Tab: { code: "Tab", keyCode: 9, text: "\t" },
	Escape: { code: "Escape", keyCode: 27 },
	Backspace: { code: "Backspace", keyCode: 8 },
	Delete: { code: "Delete", keyCode: 46 },
	ArrowUp: { code: "ArrowUp", keyCode: 38 },
	ArrowDown: { code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { code: "ArrowRight", keyCode: 39 },
	Home: { code: "Home", keyCode: 36 },
	End: { code: "End", keyCode: 35 },
	PageUp: { code: "PageUp", keyCode: 33 },
	PageDown: { code: "PageDown", keyCode: 34 },
	Space: { code: "Space", keyCode: 32, text: " " },
};

const NAMED_KEY_LOOKUP: Record<string, string> = Object.fromEntries(
	Object.keys(NAMED_KEYS).map((name) => [name.toLowerCase(), name]),
);

export interface ParsedKeyChord {
	key: string;
	code: string;
	keyCode: number;
	modifiers: number;
	text?: string;
}

/** Translate a chord such as "Control+a" or "Enter" into CDP Input.dispatchKeyEvent fields. */
export function parseKeyChord(chord: string): ParsedKeyChord {
	const parts = chord
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const keyName = parts.pop();
	if (!keyName) throw new Error(`Could not parse key chord: ${chord}`);

	let modifiers = 0;
	for (const part of parts) {
		const bit = MODIFIER_BITS[part.toLowerCase()];
		if (bit === undefined) throw new Error(`Unknown modifier "${part}" in "${chord}".`);
		modifiers |= bit;
	}

	// Models write key names inconsistently ("Enter", "enter", "arrowdown"), so match on a
	// canonical lowercase form and emit the spelling Chrome expects.
	const canonicalName = NAMED_KEY_LOOKUP[keyName.toLowerCase()];
	const named = canonicalName ? NAMED_KEYS[canonicalName] : undefined;
	const isSingleChar = [...keyName].length === 1;
	if (!named && !isSingleChar) {
		throw new Error(
			`Unsupported key "${keyName}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}.`,
		);
	}

	return {
		key: canonicalName ?? keyName,
		code: named?.code ?? codeForCharacter(keyName),
		keyCode: named?.keyCode ?? keyName.toUpperCase().charCodeAt(0),
		modifiers,
		// A modified chord such as Control+a is a shortcut, not text entry, so send no text payload.
		// Shift alone still produces text, which is why it is allowed through here.
		text:
			modifiers === 0 || modifiers === MODIFIER_BITS.shift
				? (named?.text ?? (isSingleChar ? keyName : undefined))
				: undefined,
	};
}

async function pressKey(session: PageSession, chord: string, signal: AbortSignal | undefined) {
	const parsed = parseKeyChord(chord);
	const common = {
		key: parsed.key,
		code: parsed.code,
		windowsVirtualKeyCode: parsed.keyCode,
		nativeVirtualKeyCode: parsed.keyCode,
		modifiers: parsed.modifiers,
	};
	await session.send(
		"Input.dispatchKeyEvent",
		{
			...common,
			type: parsed.text ? "keyDown" : "rawKeyDown",
			...(parsed.text ? { text: parsed.text } : {}),
		},
		{ signal },
	);
	await session.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }, { signal });
}

function codeForCharacter(character: string) {
	if (/^[a-zA-Z]$/.test(character)) return `Key${character.toUpperCase()}`;
	if (/^[0-9]$/.test(character)) return `Digit${character}`;
	return character;
}

function delay(ms: number, signal: AbortSignal | undefined) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Wait aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function matchesLevel(entry: ConsoleEntry, level: "all" | "error" | "warning" | "info") {
	if (level === "all") return true;
	const normalized = entry.level.toLowerCase();
	if (level === "error") return normalized.includes("error") || entry.kind === "exception";
	if (level === "warning") return normalized.includes("warn");
	return normalized.includes("info") || normalized.includes("log");
}

export function matchesRequest(
	entry: NetworkEntry,
	filter: { urlContains?: string; method?: string; failedOnly?: boolean },
) {
	if (filter.urlContains && !entry.url.includes(filter.urlContains)) return false;
	if (filter.method && entry.method.toUpperCase() !== filter.method.toUpperCase()) return false;
	if (filter.failedOnly && !entry.failed && (entry.status ?? 0) < 400) return false;
	return true;
}

export function formatSnapshot(snapshot: SnapshotResult) {
	const header = `${snapshot.title || "(untitled)"} — ${snapshot.url}`;
	const counts = snapshot.truncated
		? `${snapshot.nodes.length} of ${snapshot.total} elements (truncated)`
		: `${snapshot.nodes.length} elements`;
	const lines = snapshot.nodes.map((node) => {
		const parts = [`${node.ref} ${node.role}`];
		if (node.name) parts.push(`"${node.name}"`);
		if (node.value) parts.push(`value="${node.value}"`);
		if (node.state) parts.push(`[${node.state}]`);
		if (node.href) parts.push(`-> ${node.href}`);
		parts.push(`(${node.selector})`);
		return parts.join(" ");
	});
	return [header, counts, ...lines].join("\n");
}

export function formatConsoleEntry(entry: ConsoleEntry) {
	const where = entry.url ? ` ${entry.url}${entry.lineNumber ? `:${entry.lineNumber}` : ""}` : "";
	const stack = entry.stack ? `\n${entry.stack}` : "";
	return `[${entry.level}] ${entry.text}${where}${stack}`;
}

export function formatNetworkEntry(entry: NetworkEntry) {
	const status = entry.failed
		? `FAILED ${entry.errorText ?? ""}`.trim()
		: (entry.status ?? "pending");
	const duration = entry.durationMs === undefined ? "" : ` ${Math.round(entry.durationMs)}ms`;
	const size =
		entry.encodedDataLength === undefined ? "" : ` ${formatBytes(entry.encodedDataLength)}`;
	const type = entry.resourceType ? ` ${entry.resourceType}` : "";
	return `${entry.method} ${status}${duration}${size}${type} ${entry.url} (id=${entry.requestId})`;
}

export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function describeTarget(params: { ref?: string; selector?: string }, target: ResolvedElement) {
	const label = target.name ? ` "${target.name}"` : "";
	if (params.ref) return `${params.ref} <${target.tag}>${label}`;
	if (params.selector) return `${params.selector} <${target.tag}>${label}`;
	return `(${Math.round(target.x)}, ${Math.round(target.y)})`;
}

function describeSelectorOrRef(params: { ref?: string; selector?: string }) {
	return params.ref ?? params.selector ?? "the focused element";
}

function describeCondition(params: {
	selector?: string;
	text?: string;
	expression?: string;
	gone?: boolean;
}) {
	const verb = params.gone ? "disappearance of" : "";
	if (params.selector) return `${verb} selector ${params.selector}`.trim();
	if (params.text) return `${verb} text "${params.text}"`.trim();
	return `expression ${params.expression}`;
}
