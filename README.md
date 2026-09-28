<div align="center">

# pi-extensions

**我自己写、每天在用的 Pi Coding Agent 扩展。**

一条命令安装两个扩展：用 Chrome DevTools 协议操作浏览器，以及联网搜索。两者都是 Pi 原生工具，不需要 MCP 服务或额外进程。

[![pi](https://img.shields.io/badge/pi-extension-2563eb)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

</div>

---

## 亮点

- **CDP 会话池**：[chrome-devtools](./chrome-devtools) 的浏览器连接跨工具调用保持打开。浏览器可以保留用户配置、比会话活得更久，登录状态下次还在。
- **稳定的元素引用**：DOM 快照给每个元素分配固定 ref，模型按 ref 点击和填写，发出真实的鼠标和键盘事件。
- **按需加载工具**：在支持的模型上，工具通过 `chrome_devtools_load` 按需加载，不占满提示词。
- **复用已有凭据的搜索**：[websearch](./websearch) 走 OpenAI Codex 的搜索接口，使用 Pi 已持有的 `openai-codex` 凭据。它不读 `~/.codex/auth.json`，不爬搜索结果页，也不启动嵌套代理。
- **单仓库多扩展**：用 npm workspaces 管理，解决了 Pi 安装 git 包时只在根目录执行 `npm install` 的问题，详见下方“开发须知”。

## 工具一览

**chrome-devtools**：所有工具以 `chrome_devtools_` 开头。

```
list_pages   select_page   navigate   evaluate   screenshot   snapshot   click
fill         press         wait_for   console    network      emulate    cdp_send
```

`console` 和 `network` 保留滚动日志；`emulate` 模拟设备；`cdp_send` 直接发送原始协议命令，覆盖封装之外的情况。另有两个 WebMCP 工具，需要在设置里开启。

**websearch**：一个工具 `web_search`，支持 `search`、`open`、`click` 和 `find` 四种命令。

## 快速开始

```bash
pi install git:github.com/Mist-wu/pi-extensions
```

只想装其中一个扩展时，在 `settings.json` 里用对象形式，按目录匹配：

```json
{
  "packages": [
    { "source": "git:github.com/Mist-wu/pi-extensions", "extensions": ["chrome-devtools/**"] }
  ]
}
```

## 项目结构

```text
pi-extensions/
├── package.json          # npm workspaces 和 pi.extensions 入口列表
├── chrome-devtools/
└── websearch/
```

目录是平铺的，因为 Pi 只往下找一层扩展目录：`chrome-devtools/` 能找到，`packages/chrome-devtools/` 找不到。

## 开发

```bash
npm install
npm run check
```

`check` 会在每个 workspace 里执行构建、lint、类型检查和测试。chrome-devtools 还有驱动真实 Chrome 的端到端测试：

```bash
cd chrome-devtools && npm run smoke:e2e
```

### 开发须知

新增扩展前需要知道两点。

> [!IMPORTANT]
> **workspaces 不能去掉，这里的包也不发布到 npm。** Pi 安装 git 包时只在仓库根目录执行 `npm install`，不进子目录。没有 workspaces，子包的依赖就不会安装，扩展启动时加载失败。

> [!NOTE]
> **入口文件在根 `package.json` 的 `pi.extensions` 里显式列出。** 自动发现也能找到它们，但会把根目录下任何 `.ts` 或 `.js` 文件都当成扩展，比如根目录的 `vitest.config.ts` 会被当成插件加载。显式列出就跳过了自动发现。

> [!WARNING]
> 在这个仓库里开发，不要改 `~/.pi/agent/git/…` 下的副本。那份副本归 Pi 管理，每次更新都会执行 `git clean -fdx`。

## License

MIT。`chrome-devtools/` 另附上游的署名，见其 [LICENSE](./chrome-devtools/LICENSE)。
