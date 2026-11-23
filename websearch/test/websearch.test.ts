import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import webSearch from "../index.ts";

type SearchTool = {
	execute: (
		toolCallId: string,
		params: { search_query: Array<{ q: string }> },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ReturnType<typeof searchContext>,
	) => Promise<{ content: Array<{ text: string }>; details: { fullOutputPath?: string } }>;
};

function accountToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function searchContext(history: Array<{ role: string; content: string }> = []) {
	return {
		model: undefined,
		modelRegistry: {
			async getProviderAuth() {
				return { auth: { apiKey: accountToken(), baseUrl: "https://example.test" } };
			},
			getProvider() {
				return { baseUrl: "https://example.test" };
			},
			getAvailable() {
				return [{ provider: "openai-codex", id: "gpt-5.4" }];
			},
		},
		sessionManager: {
			getSessionId() {
				return "session-test";
			},
			getBranch() {
				return history.map(message => ({ type: "message", message }));
			},
		},
	};
}

function registerTool(): SearchTool {
	let tool: SearchTool | undefined;
	webSearch({
		registerTool(value: SearchTool) {
			tool = value;
		},
	} as never);
	if (!tool) throw new Error("web_search was not registered");
	return tool;
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
	const status = init.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
		async json() {
			return body;
		},
		async text() {
			return typeof body === "string" ? body : JSON.stringify(body);
		},
	} as unknown as Response;
}

async function withFetch<T>(
	fetchImpl: typeof fetch,
	run: (tool: SearchTool) => Promise<T>,
): Promise<T> {
	const previous = globalThis.fetch;
	globalThis.fetch = fetchImpl;
	try {
		return await run(registerTool());
	} finally {
		globalThis.fetch = previous;
	}
}

const query = { search_query: [{ q: "pi extensions" }] };

test("search history starts with a user turn and ends at the current request", async () => {
	const history = [
		{ role: "assistant", content: "intro" },
		{ role: "user", content: "first" },
		{ role: "assistant", content: "answer" },
		{ role: "user", content: "follow-up" },
		{ role: "assistant", content: "after request" },
	];
	const cases = [
		[1, undefined],
		[3, ["first"]],
		[5, ["first", "answer", "follow-up"]],
	] as const;
	for (const [length, expected] of cases) {
		let input: Array<{ content: Array<{ text: string }> }> | undefined;
		await withFetch(async (_url, init) => {
			input = JSON.parse(String(init?.body)).input;
			return jsonResponse({ output: "ok" });
		}, tool => tool.execute("call", query, undefined, undefined, searchContext(history.slice(0, length))));
		assert.deepEqual(input?.map(item => item.content[0].text), expected);
	}
});

test("cancelling while the response body is read is not reported as invalid JSON", async () => {
	const caller = new AbortController();
	await withFetch(async (_input, init) => {
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: () => null },
			json: () =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new Error("The operation was aborted"));
					});
				}),
			async text() {
				return "";
			},
		} as unknown as Response;
	}, async (tool) => {
		const pending = tool.execute("call", query, caller.signal, undefined, searchContext());
		caller.abort();
		await assert.rejects(pending, /Web search cancelled/);
	});
});

test("JSON null and a missing string output are shape errors", async () => {
	for (const body of [null, { results: [] }, { output: 12 }]) {
		await withFetch(async () => jsonResponse(body), async (tool) => {
			await assert.rejects(
				tool.execute("call", query, undefined, undefined, searchContext()),
				/no text output/,
			);
		});
	}
	await withFetch(
		async () =>
			({
				ok: true,
				status: 200,
				statusText: "OK",
				headers: { get: () => null },
				async json() {
					throw new SyntaxError("Unexpected token");
				},
				async text() {
					return "";
				},
			}) as unknown as Response,
		async (tool) => {
			await assert.rejects(
				tool.execute("call", query, undefined, undefined, searchContext()),
				/invalid JSON/,
			);
		},
	);
});

test("429 and 5xx honor Retry-After and a later success", async () => {
	const statuses = [429, 503, 200];
	let calls = 0;
	await withFetch(async () => {
		const status = statuses[calls] ?? 200;
		calls += 1;
		if (status === 200) return jsonResponse({ output: "recovered" });
		return jsonResponse("busy", { status, headers: { "retry-after": "0" } });
	}, async (tool) => {
		const result = await tool.execute("call", query, undefined, undefined, searchContext());
		assert.equal(result.content[0]?.text, "recovered");
		assert.equal(calls, 3);
	});
});

test("cancelling during backoff does not send another request", async () => {
	const caller = new AbortController();
	let calls = 0;
	await withFetch(async () => {
		calls += 1;
		queueMicrotask(() => caller.abort());
		return jsonResponse("later", { status: 429, headers: { "retry-after": "30" } });
	}, async (tool) => {
		await assert.rejects(
			tool.execute("call", query, caller.signal, undefined, searchContext()),
			/Web search cancelled/,
		);
		assert.equal(calls, 1);
	});
});

test("UTF-8 output is truncated visibly and the saved file stays complete", async () => {
	const output = `${"测".repeat(20_000)}结尾`;
	await withFetch(async () => jsonResponse({ output }), async (tool) => {
		const result = await tool.execute("call", query, undefined, undefined, searchContext());
		const visible = result.content[0]?.text ?? "";
		assert.ok(visible.length < output.length);
		assert.match(visible, /Output truncated/);
		assert.equal(typeof result.details.fullOutputPath, "string");
		const saved = await readFile(result.details.fullOutputPath ?? "", "utf8");
		assert.equal(saved, output);
		assert.ok(!visible.includes("\uFFFD"));
	});
});
