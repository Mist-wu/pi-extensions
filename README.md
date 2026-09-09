# 🌐 pi-chrome-devtools — Inspect and Control Chrome from Pi

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Drive and debug Chrome from Pi through the Chrome DevTools Protocol: inspect tabs, navigate, snapshot
the DOM, click and type with real input events, read the console and network log, emulate devices,
and reach any protocol domain directly.
Use these native Pi tools for web debugging, UI validation, and browser-assisted investigation without an MCP server.

> Derived from [`@narumitw/pi-chrome-devtools`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-chrome-devtools)
> 0.53.1 (MIT), itself inspired by [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).
> This fork adds pooled CDP sessions, console and network recording, real input, and a raw protocol escape hatch.
> Compatibility with either upstream is not guaranteed.

## ✨ Features

- Lists and selects inspectable pages, navigates URLs, evaluates JavaScript, and captures PNG screenshots.
- Keeps one pooled CDP connection per page for the whole Pi session, enabling each domain at most once.
- Records console messages, uncaught exceptions, and network requests continuously, so a later tool call can read back what happened before it ran.
- Drives the page with trusted `Input` events for clicks, typing, and keyboard shortcuts, which pages cannot distinguish from a user.
- Captures a ref-addressable text snapshot of the page that costs a fraction of a screenshot.
- Emulates device viewports, user agents, colour scheme, network throttling, and CPU slowdown.
- Exposes any Chrome DevTools Protocol command for domains the dedicated tools do not wrap.
- Reuses an existing CDP endpoint or launches an isolated Chromium-family browser on first use.
- Recovers from stale page selections and explains browser startup or endpoint failures.
- Loads explicitly approved unpacked extensions only in an extension-owned Chrome for Testing or Chromium process.
- Uses native deferred browser tools when supported and exposes allowed tools eagerly otherwise.
- Provides availability controls, setup guidance, status, and help through `/chrome-devtools`.
- Shows compact expandable results and activity only while browser tools are running.
- Persists reviewed tool availability while keeping browser connection settings machine-owned.
- Offers opt-in experimental WebMCP discovery and invocation through two fixed gateway tools without dynamically registering page-provided definitions.

## 📦 Install

Install from GitHub:

```bash
pi install git:github.com/Mist-wu/pi-chrome-devtools
```

Try it for one session without installing:

```bash
pi -e git:github.com/Mist-wu/pi-chrome-devtools
```

Or load a local checkout:

```bash
npm install
pi -e .
```

The package declares `src/index.ts`, which Pi's Jiti runtime loads directly, so a checkout needs no
build step to run. `npm run build` produces the bundled `dist/` runtime used for npm packaging.

Pi extensions run with your user permissions.
Review third-party extension source before installing it.

## 🚀 Quick start

Start Pi and ask the agent to load the browser capability needed for the task.
By default, the extension tries `http://127.0.0.1:9222` and launches an isolated local Chromium-family browser if that endpoint is unavailable.
Run `/chrome-devtools` to review status, settings, help, and available tools.
WebMCP remains disabled until you explicitly enable it.

## 🌐 Browser setup

By default, the extension attaches to `http://127.0.0.1:9222` or launches an isolated local browser on first use.
It never closes an external browser.
Use `/chrome-devtools` → **Browser settings** to change the endpoint, auto-launch policy, or executable.

Read the [browser setup reference](./docs/browser-setup.md) for endpoint requirements, executable discovery, unpacked extensions, manual launch, and deprecated environment overrides.
Manual settings edits apply after `/reload` or session replacement.

> [!WARNING]
> Unpacked extensions execute privileged browser code; load only trusted code.
> They require an extension-owned Chrome for Testing or Chromium process.
> Trusted project settings may replace only the extension-path list, not machine-owned connection settings.

### Experimental WebMCP

> [!WARNING]
> WebMCP is experimental, disabled by default, and subject to Chrome protocol changes.
> Page tools use the visible page's current authentication and require confirmation on every call.

Enable `webmcp.enabled` only in user settings, then choose which gateway tools are available through `/chrome-devtools tools`.
Project settings cannot enable WebMCP or weaken confirmation.
See [WebMCP setup and troubleshooting](./docs/browser-setup.md#experimental-webmcp) for compatible Chrome builds, browser flags, schema limits, and stale-page recovery.

## 🛠️ Tools

Navigation and inspection:

- `chrome_devtools_load` — find and load browser capabilities relevant to a task.
- `chrome_devtools_list_pages` — list inspectable Chrome tabs/pages.
- `chrome_devtools_select_page` — select the active page for later tool calls.
- `chrome_devtools_navigate` — navigate a page to a URL; if no page exists, create one first.
- `chrome_devtools_evaluate` — evaluate JavaScript in the selected page.
- `chrome_devtools_screenshot` — capture a PNG screenshot and save it as a PNG file.
- `chrome_devtools_snapshot` — capture a compact outline of the page's interactive elements with stable `e1`, `e2`, … refs.

Interaction, with real browser input events:

- `chrome_devtools_click` — click, double-click, right-click, or hover an element (by ref, selector, or coordinates).
- `chrome_devtools_fill` — focus a field, clear it, type into it, and optionally submit.
- `chrome_devtools_press` — send a key or chord such as `Enter`, `Escape`, or `Control+a`.
- `chrome_devtools_wait_for` — wait for a selector, text, or expression instead of guessing at a sleep.

Debugging:

- `chrome_devtools_console` — read recorded console messages and uncaught exceptions, filtered by level.
- `chrome_devtools_network` — list recorded requests, filter them, and fetch one response body by id.
- `chrome_devtools_emulate` — emulate a device viewport, user agent, colour scheme, network preset, or CPU slowdown.
- `chrome_devtools_cdp_send` — send any CDP command, for `Debugger`, `Profiler`, `Storage`, `Accessibility`, `Fetch`, and the rest.

Experimental WebMCP:

- `chrome_devtools_webmcp_list_tools` — list bounded frame-aware WebMCP descriptors from the selected page when experimental WebMCP is enabled.
- `chrome_devtools_webmcp_call_tool` — invoke one listed page tool after exact identity revalidation and user confirmation.

### Snapshots and refs

`chrome_devtools_snapshot` registers each element it reports in the page and returns a short ref for it:

```text
Sign in — https://example.com/login
14 elements
e1 heading "Sign in" (h1)
e2 textbox "Email address" value="prefilled" (#email)
e3 button "Sign in" (#go)
e4 link "Forgot password?" -> /reset (a:nth-of-type(1))
```

Pass those refs to `chrome_devtools_click` and `chrome_devtools_fill`. A ref whose element has left
the document is rejected with a message telling the agent to take a fresh snapshot, rather than
silently acting on the wrong node. Refs are per-snapshot: taking a new one renumbers them.

### Recording and session lifetime

Opening a page session enables `Page`, `Runtime`, `Log`, and `Network`, and starts recording. Both
recorders are bounded ring buffers (500 entries each) and report how many older entries they dropped.
Sessions stay open for the Pi session, are swept after 5 minutes idle, and are closed on session
replacement and shutdown. Recording begins when the session opens, so anything logged before the
first browser tool call in a session is not captured — navigate through
`chrome_devtools_navigate` if you need a full page load in the log.

### Tool exposure

The extension registers seventeen tools: one loader, fourteen stable DevTools capabilities, and two fixed experimental WebMCP gateways.
With native deferred-tool support, only `chrome_devtools_load` starts active.
The loader accepts a task-oriented `query`, matches it against the fourteen stable capabilities plus enabled WebMCP gateways, and adds matching available tools without removing any active Pi tool.
Loaded capability tools remain active for the rest of the session unless the user makes them unavailable through `/chrome-devtools`.

Pi uses native deferred tool references on compatible Anthropic models, native additional-tools or tool-search loading on compatible OpenAI and Codex Responses models, and native Kimi loading on compatible OpenAI Chat Completions models.
Kimi-compatible models declare `compat.deferredToolsMode: "kimi"` in Pi's model metadata.
`azure-openai-responses` remains eager because Pi's Azure adapter does not implement native deferred tool-search serialization.

When the selected model/provider lacks native deferred support, the extension activates every capability allowed by settings before the next model request instead of using Pi's cache-invalidating lazy-loading fallback.
After a session enters eager exposure, it stays eager across later model switches to avoid removing tool definitions within that session.
The capability tools omit active-only prompt snippets so native deferred loading does not rebuild the system-prompt prefix.

The saved `tools` array controls which capabilities the extension may expose.
The `webmcp.enabled` gate takes precedence, so persisted WebMCP names cannot bypass a disabled gate.
Page-provided tool definitions appear only in list results and never alter Pi's provider-visible tool definitions.
An empty array leaves the loader active but makes every browser capability unavailable.

### Screenshot files

`chrome_devtools_screenshot` always saves the captured PNG to disk.
If `savePath` is omitted, the extension writes a unique temp file such as:

```text
/tmp/pi-chrome-devtools-screenshot-<uuid>.png
```

Pass `savePath` to choose the output path:

```js
chrome_devtools_screenshot({
  fullPage: true,
  savePath: "artifacts/homepage.png",
});
```

Relative `savePath` values resolve from Pi's current working directory.
A single leading `@` is stripped to match Pi file-mention paths.
Absolute paths are accepted only when they stay inside the current working directory or the OS temp directory.
Paths containing `..` segments, NUL bytes, symlinked parent directories, directories as targets, final symbolic-link targets, or other non-regular file targets are rejected.
Existing regular files at the target path are replaced.
The tool result includes the resolved path, byte count, and an inline image block when the active model/provider can consume images.
If the model cannot inspect the inline image, ask it to read the saved path, for example `read({ path: "artifacts/homepage.png" })`.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/chrome-devtools` | Manage browser-tool availability and browser settings. |
| `/chrome-devtools help` | Show command usage. |
| `/chrome-devtools quickstart` | Show the CDP endpoint, launch candidates, and setup hints. |
| `/chrome-devtools status` | Inspect tools, settings sources, and the last browser launch without probing or starting Chrome. |
| `/chrome-devtools settings` | Change browser settings; successful edits save immediately. |
| `/chrome-devtools tools` (aliases: `toggle`, `select`) | Stage tool availability, review the result, and apply it. |
| `/chrome-devtools enable` (alias: `on`) | Immediately make all currently gated capabilities available and save the selection. |
| `/chrome-devtools disable` (alias: `off`) | Immediately make all capabilities unavailable and save the empty selection. |

All routes support TUI and RPC and reject unknown or trailing arguments.
Only `enable` and `disable` also support print and JSON modes.
Disabling capabilities leaves the slash command and `chrome_devtools_load` available; see [Tool exposure](#tool-exposure).

Menu tool changes require **Apply tool changes**; cancellation discards the unconfirmed draft.
Failed apply leaves previous tool availability and settings intact and retains the draft for retry.
Browser settings instead save immediately, and closing the flow does not undo them.
See [Browser setup](./docs/browser-setup.md) for prerequisites and environment-override precedence, and [Experimental WebMCP](#experimental-webmcp) before enabling its gateways.

## ⚙️ Settings

The available capability names are saved to:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-chrome-devtools.json
```

Use **Browser settings** for connection preferences or **Choose available browser tools…** for tool availability.
For example, this partial document attaches to a user-started browser without launching another:

```json
{
  "browser": {
    "endpoint": "http://127.0.0.1:9222",
    "autoLaunch": false
  }
}
```

The same file owns `browser.endpoint`, `browser.autoLaunch`, `browser.executablePath`, `browser.extensionPaths`, and user-only `webmcp.enabled`.
Browser connection fields and `webmcp.enabled` are machine-owned user settings; trusted project files may replace only `browser.extensionPaths`.
Confirmed menu changes apply before the next browser connection and close only an extension-owned managed browser.
Manual JSON edits and unpacked-extension changes apply after `/reload` or session replacement.

When the file is missing or invalid, the extension preserves Pi's current Chrome DevTools availability policy instead of replacing it.
A valid saved catalog is restored on Pi startup and `/reload`, with capability definitions exposed natively deferred or eagerly according to model/provider support.
A missing file is created by the first confirmed browser or tool setting.
Within one Pi process, all browser and tool saves run in invocation order, reread the latest valid document, publish by temporary-file rename, and preserve unknown fields.
Malformed JSON or invalid recognized fields make menu mutation unavailable and block direct saves without replacement; a failed save restores the prior displayed and effective state.

Compatibility: older versions used `pi-chrome-devtools-settings.json`.
A legacy-only file remains readable with a warning and is never modified automatically; rename it to `pi-chrome-devtools.json`.
The first subsequent settings save writes the canonical file.
If both files exist, `pi-chrome-devtools.json` wins and the legacy file is ignored.
The legacy filename is deprecated and will be removed in a future major release.

## 🔒 Security and privacy

A CDP connection can inspect and change browser content, execute JavaScript, and access the selected browser profile's authenticated pages.
Connect only to trusted endpoints and profiles.

The extension never closes an external browser.
It closes only managed browser processes that it started and removes their temporary profiles on a best-effort basis.

Unpacked extensions run privileged browser code and are loaded only into an isolated managed browser after explicit configuration.
WebMCP page tools use the visible page's authentication and require confirmation before every call.
Screenshot output is restricted to the current working directory or OS temporary directory as described above.

## 🧠 Use cases

- Debug front-end applications with an AI coding agent.
- Verify DOM state after code changes.
- Capture screenshots for visual inspection.
- Drive local browser workflows without a separate MCP server.
- Combine with Pi coding tools for end-to-end web app fixes.

## 🗂️ Package layout

```text
pi-chrome-devtools/
├── src/
│   ├── index.ts                       # Thin Pi entrypoint
│   ├── chrome-devtools.ts             # Registration, commands, session lifecycle
│   ├── cdp-client.ts                  # WebSocket CDP transport
│   ├── cdp-session.ts                 # Pooled sessions, console and network recorders
│   ├── page-scripts.ts                # Scripts evaluated inside the inspected page
│   ├── tools.ts                       # Navigation and inspection tools
│   ├── advanced-tools.ts              # Snapshot, input, wait, console, network, emulate, raw CDP
│   ├── browser-manager.ts             # Endpoint discovery and managed browser launch
│   └── settings.ts / menu.ts          # Persistence and the /chrome-devtools surface
├── dist/                              # Generated Jiti runtime
├── scripts/build-runtime.mjs          # Runtime builder
├── scripts/smoke-e2e.mjs              # End-to-end checks against a real Chrome
├── docs/                              # Reference documentation
├── reference/webmcp/                  # Compatibility prototype, not shipped
└── test/                              # Behavior, lifecycle, and unit coverage
```

The generated runtime is built from `src/index.ts` and does not import back into `src`.

## 🧪 Development

```bash
npm install
npm run check      # build, lint, typecheck, unit tests
npm run smoke:e2e  # drives a real headless Chrome end to end
```

`npm run smoke:e2e` launches Chrome with an isolated temporary profile, serves a fixture page, and
exercises snapshots, real input, waiting, console and network recording, emulation, and raw CDP
against it. Point it at another binary with `PI_CHROME_DEVTOOLS_BROWSER`.

## 🔎 Keywords

Pi extension, Pi coding agent, Chrome DevTools Protocol, CDP, WebMCP, browser automation, web debugging, JavaScript evaluation, screenshot automation, AI coding agent tools.

## 📄 License

MIT.
See [`LICENSE`](./LICENSE).
