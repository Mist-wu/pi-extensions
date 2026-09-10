<div align="center">

# websearch

**Search the web from Pi, through OpenAI Codex's search endpoint.**

Registers a single `web_search` tool that reuses the `openai-codex` credential Pi
already holds — no scraping, no nested agent, no second login.

<br/>

[![pi](https://img.shields.io/badge/pi-extension-2563eb)](https://pi.dev)
[![Codex](https://img.shields.io/badge/backend-Codex%20search-000000?logo=openai&logoColor=white)](https://openai.com/codex/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](../LICENSE)

</div>

---

## Install

Part of [`pi-extensions`](https://github.com/Mist-wu/pi-extensions):

```bash
pi install git:github.com/Mist-wu/pi-extensions
```

To take only this extension, use the object form in `settings.json`:

```json
{
  "packages": [
    { "source": "git:github.com/Mist-wu/pi-extensions", "extensions": ["websearch/**"] }
  ]
}
```

## Authentication

Run Pi's `/login` and configure **OpenAI Codex**. The credential is refreshed by Pi's provider
runtime before each request. In a running Pi TUI, `/reload` picks up a fresh install.

## Tool

The extension auto-registers one tool:

```text
web_search
```

Supported inputs mirror Codex's standalone search commands:

| | |
| --- | --- |
| `search_query` `image_query` | Text and image search |
| `open` `click` `find` `screenshot` | Navigate within a result |
| `finance` `weather` `sports` `time` | Auxiliary lookups |
| `response_length` | `short`, `medium`, or `long` |

Reference IDs returned by a search can be reused by later `open`, `click`, `find`, and
`screenshot` calls in the same Pi session.

Only `search_query` carries Codex's explicit four-query limit. Other supplied operation arrays
must be non-empty but have no blanket four-item cap. Positive day/game counts and non-negative
line/link/page indexes are still validated.

## Why this implementation

Originally based on OpenAI Codex source commit `646f7c0a91b8e327d263335da68ae8ef212895ce`,
last checked against `16ff14c266179e6a762dc8081e9dab73a96683e0`:

- `codex-rs/ext/web-search/src/tool.rs` registers the namespaced `web.run` tool.
- `codex-rs/codex-api/src/search.rs` defines `SearchRequest`, `SearchCommands`, and `SearchResponse`.
- `codex-rs/codex-api/src/endpoint/search.rs` sends `POST alpha/search` against the Codex provider base URL.
- `codex-rs/ext/web-search/web_run_description.md` documents search/open/click/find and the auxiliary lookup commands.

Pi already has an `openai-codex` provider and OAuth refresh support. This extension resolves
that credential through `ctx.modelRegistry.getProviderAuth("openai-codex")` and calls:

```text
POST https://chatgpt.com/backend-api/codex/alpha/search
```

It does **not** read `~/.codex/auth.json`, copy refresh tokens, scrape search-engine HTML, or
spawn a nested Codex agent.

## Search context

The request follows Codex's recent-history policy:

- retain the previous user message, assistant text after it, and the current user message;
- exclude assistant text before that window and text emitted after the current user message;
- retain user text and cap assistant text across the window to approximately 1,000 tokens.

This keeps follow-up questions understandable without letting stale assistant output displace
the current request.

## Length controls

The three server controls are intentionally independent:

| Control | Where | Values |
| --- | --- | --- |
| `response_length` | Tool argument | `short`, `medium`, `long` — search-result detail |
| `PI_CODEX_WEB_SEARCH_CONTEXT_SIZE` | Environment | `low`, `medium`, `high` (default `medium`) — retrieval context |
| `PI_CODEX_WEB_SEARCH_MAX_OUTPUT_TOKENS` | Environment | Positive integer up to `128000` (default `6000`) — output ceiling |

```bash
export PI_CODEX_WEB_SEARCH_CONTEXT_SIZE=high
export PI_CODEX_WEB_SEARCH_MAX_OUTPUT_TOKENS=8000
pi
```

Four text queries are automatically promoted from a missing or `short` response length to
`medium`, as Codex's tool guidance requires. Pi's separate 2,000-line / 50KB visible-output
safety limit still applies.

## Search and citation behavior

The tool guidance follows Codex's main rules: browse for explicit or unstable requests, prefer
primary and authoritative sources, use direct descriptive Markdown links near supported claims,
and never expose internal `turn...` reference IDs in final answers.

> [!IMPORTANT]
> Retrieved pages are treated as untrusted evidence, never as instructions.

## Stability

> [!WARNING]
> `/codex/alpha/search` is an internal alpha endpoint found in Codex source, not a documented
> public API. Endpoint construction and request shaping are kept isolated so they can be
> updated if Codex changes the protocol.

## License

MIT. See the repository [`LICENSE`](../LICENSE).
