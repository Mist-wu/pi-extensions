# Codex Web Search for Pi

A global Pi extension that registers a `web_search` tool backed by OpenAI Codex's standalone search endpoint.

## Why this implementation

Originally based on OpenAI Codex source commit `646f7c0a91b8e327d263335da68ae8ef212895ce` and last checked against `16ff14c266179e6a762dc8081e9dab73a96683e0`:

- `codex-rs/ext/web-search/src/tool.rs` registers the namespaced `web.run` tool.
- `codex-rs/codex-api/src/search.rs` defines `SearchRequest`, `SearchCommands`, and `SearchResponse`.
- `codex-rs/codex-api/src/endpoint/search.rs` sends `POST alpha/search` against the Codex provider base URL.
- `codex-rs/ext/web-search/web_run_description.md` documents search/open/click/find and the auxiliary lookup commands.

Pi already has an `openai-codex` provider and OAuth refresh support. This extension resolves that credential through `ctx.modelRegistry.getProviderAuth("openai-codex")` and calls:

```text
POST https://chatgpt.com/backend-api/codex/alpha/search
```

It does **not** read `~/.codex/auth.json`, copy refresh tokens, scrape search-engine HTML, or spawn a nested Codex agent.

## Tool

The extension auto-registers:

```text
web_search
```

Supported inputs mirror Codex's standalone search commands:

- `search_query`
- `image_query`
- `open`
- `click`
- `find`
- `screenshot`
- `finance`
- `weather`
- `sports`
- `time`
- `response_length`

Reference IDs returned by a search can be reused by later `open`, `click`, `find`, and `screenshot` calls in the same Pi session.

Only `search_query` has Codex's explicit four-query limit. Other supplied operation arrays must be non-empty but do not have the previous blanket four-item cap. Positive day/game counts and non-negative line/link/page indexes are still validated.

## Search context

The request follows Codex's recent-history policy:

- retain the previous user message, assistant text after it, and the current user message;
- exclude assistant text before that window and text emitted after the current user message;
- retain user text and cap assistant text across the window to approximately 1,000 tokens.

This keeps follow-up questions understandable without allowing stale assistant output to displace the current request.

## Independent length controls

The three server controls are intentionally independent:

- `response_length` is a tool argument (`short`, `medium`, or `long`) controlling search-result detail;
- `PI_CODEX_WEB_SEARCH_CONTEXT_SIZE` controls retrieval context (`low`, `medium`, or `high`; default `medium`);
- `PI_CODEX_WEB_SEARCH_MAX_OUTPUT_TOKENS` controls the endpoint output ceiling (positive integer up to `128000`; default `6000`).

For example:

```bash
export PI_CODEX_WEB_SEARCH_CONTEXT_SIZE=high
export PI_CODEX_WEB_SEARCH_MAX_OUTPUT_TOKENS=8000
pi
```

Four text queries are automatically promoted from a missing/`short` response length to `medium`, as required by Codex's tool guidance. Pi's separate 2,000-line/50KB visible-output safety limit still applies.

## Search and citation behavior

The tool guidance follows Codex's main rules: browse for explicit or unstable requests, prefer primary and authoritative sources, use direct descriptive Markdown links near supported claims, and never expose internal `turn...` reference IDs in final answers. Retrieved pages are treated as untrusted evidence rather than instructions.

## Authentication

Run Pi's `/login` and configure **OpenAI Codex**. The credential is refreshed by Pi's provider runtime before each request.

## Loading

The extension lives in Pi's global auto-discovery directory:

```text
~/.pi/agent/extensions/codex-web-search/index.ts
```

In an existing Pi TUI, run `/reload`. New Pi processes load it automatically.

## Stability

`/codex/alpha/search` is an internal alpha endpoint found in Codex source, not a separately documented public API. The extension keeps endpoint construction and request shaping isolated so it can be updated if Codex changes the protocol.
