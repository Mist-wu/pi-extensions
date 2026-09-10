# pi-extensions

Pi Coding Agent extensions, kept in one repository so they share tooling and ship together.

| Extension | Tools | What it does |
| --- | --- | --- |
| [`chrome-devtools/`](./chrome-devtools) | `chrome_devtools_*` | Drive and debug Chrome over the DevTools Protocol: pooled sessions, DOM snapshots, real input events, console and network recording, device emulation, and a raw protocol escape hatch. |
| [`websearch/`](./websearch) | `web_search` | Search the web through OpenAI Codex's search endpoint, reusing Pi's existing `openai-codex` credential. |

## Install

```bash
pi install git:github.com/Mist-wu/pi-extensions
```

That installs every extension in the repository. To take a subset, use the object form in
`settings.json` and match the directories you want:

```json
{
  "packages": [
    { "source": "git:github.com/Mist-wu/pi-extensions", "extensions": ["chrome-devtools/**"] }
  ]
}
```

## Layout

Extension entrypoints are listed explicitly in the root `package.json` under `pi.extensions`.
Pi would otherwise auto-discover them, but auto-discovery also treats any stray `.ts` or `.js`
file in the repository root as an extension — listing them keeps that from surprising us.

```text
pi-extensions/
├── package.json          # npm workspaces + the pi.extensions entrypoint list
├── chrome-devtools/      # Chrome DevTools Protocol tools
└── websearch/            # Codex-backed web_search tool
```

The workspaces are not cosmetic. Pi runs `npm install` only in the repository root when it
installs a git package, so a workspace member's dependencies would otherwise never be installed.

## Development

```bash
npm install
npm run check
```

`check` fans out to every workspace that defines it. To work on a single extension, run the
same scripts from inside its directory.

Develop here, not in `~/.pi/agent/git/…` — Pi runs `git clean -fdx` in its own clone on update.

## License

MIT. `chrome-devtools/` additionally carries upstream attribution in
[`chrome-devtools/LICENSE`](./chrome-devtools/LICENSE).
