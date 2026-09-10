<div align="center">

# pi-extensions

**Pi Coding Agent extensions I build and actually use.**

<br/>

[![pi](https://img.shields.io/badge/pi-extension-2563eb)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-186%20passing-22c55e)](./chrome-devtools/test)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](https://opensource.org/license/mit)

</div>

---

```bash
pi install git:github.com/Mist-wu/pi-extensions
```

Two extensions, one install. Both are native Pi tools — no MCP server, no separate process.

<br/>

### [chrome-devtools](./chrome-devtools) — drive and debug Chrome

Pooled CDP sessions that stay open across tool calls, DOM snapshots with stable element refs,
real mouse and keyboard events, rolling console and network logs, device emulation, and a raw
protocol escape hatch for anything the wrappers don't cover.

```
list_pages   select_page   navigate   evaluate   screenshot   snapshot   click
fill         press         wait_for   console    network      emulate    cdp_send
```

All prefixed `chrome_devtools_`. Two more WebMCP tools sit behind a setting. On models that
support it they load on demand via `chrome_devtools_load` rather than filling the prompt.

The browser can keep a profile and outlive the session, so a login survives to the next one.

### [websearch](./websearch) — search the web

One tool, `web_search`, with `search` / `open` / `click` / `find` commands. It goes through
OpenAI Codex's search endpoint using the `openai-codex` credential Pi already holds — it does
not read `~/.codex/auth.json`, scrape search results, or spawn a nested agent.

<br/>

## Installing a subset

The command above installs everything. To take one extension, use the object form in
`settings.json` and match the directory:

```json
{
  "packages": [
    { "source": "git:github.com/Mist-wu/pi-extensions", "extensions": ["chrome-devtools/**"] }
  ]
}
```

## Layout

```text
pi-extensions/
├── package.json          # npm workspaces + the pi.extensions entrypoint list
├── chrome-devtools/
└── websearch/
```

Flat, because Pi discovers extensions exactly one directory deep — `chrome-devtools/`, never
`packages/chrome-devtools/`.

Two details worth knowing before adding a third extension:

> [!IMPORTANT]
> **The workspaces are load-bearing, and nothing here is published to npm.** Pi runs
> `npm install` only in the repository root when installing a git package, never in a
> subdirectory. Without workspaces a member's dependencies are simply never installed, and
> the extension fails to load at startup.

> [!NOTE]
> **Entrypoints are listed explicitly** in the root `package.json` under `pi.extensions`.
> Auto-discovery would find them anyway, but it also treats any stray `.ts` or `.js` file in
> the repository root as an extension — a root `vitest.config.ts` would be loaded as a plugin.
> Listing them skips discovery entirely.

## Development

```bash
npm install
npm run check
```

`check` fans out to every workspace — build, lint, typecheck, tests. Run the same scripts
inside a package to work on it alone. chrome-devtools also drives a real Chrome end to end:

```bash
cd chrome-devtools && npm run smoke:e2e
```

> [!WARNING]
> Work here, not in `~/.pi/agent/git/…`. That copy belongs to Pi, which runs `git clean -fdx`
> in it on every update.

## License

MIT. `chrome-devtools/` additionally carries upstream attribution in its
[LICENSE](./chrome-devtools/LICENSE).
