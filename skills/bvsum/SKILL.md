---
name: bvsum
description: 总结哔哩哔哩视频。用户给出 B站链接（bilibili.com / b23.tv）或 BV号并想知道视频讲了什么、要总结或要字稿时使用。下载音频，取官方字幕或本地 Whisper 转录，必要时用 web_search 补充，然后自由组织总结。
compatibility: macOS；需要 Python 3、ffmpeg/ffprobe，以及 uvx（mlx-whisper）或 whisper-cli + 本地模型。联网补充依赖本仓库的 websearch 扩展（可选）。
allowed-tools: read bash web_search
---

# BVSum

## 1. 取材料

在本 skill 目录下运行：

```bash
python3 scripts/prepare.py '<B站链接或BV号>'
```

脚本下载音频（m4a），优先取 B站官方字幕，没有字幕就用本地 Whisper 转录。所有文件放在 `/tmp/bvsum/<BV号>/`，重启后自动清空。最后一行输出 `.bvsum.json` manifest 路径，里面有 `pubdate`、简介，每个分 P 有 `transcript_path`、`srt_path`、`audio_path`、`source`、`chapters`。

把字稿完整读完再动笔。长视频转录要几分钟，bash 调用要给足超时。

机器转录会把专有名词听错，中英混杂时尤其多（模型名、公司名、人名常被写成音近的词）。读的时候先在心里建一张"转录→实际"的对照表，拿不准的可以联网确认。

- 字稿乱码、语言识别错误或大段重复：`--force --language zh`（或 `en`）重转。
- 长视频后半段明显漂移：用 ffmpeg 把 m4a 切成 10–20 分钟的段分别转录。
- `b23.tv` 短链先用 `curl -sIL` 取到跳转后的地址。
- 只要字稿不要音频：`--no-audio`（仅在有官方字幕时生效）。

## 2. 联网补充

拿不准的专有名词、关键数字，或视频发布后可能已变化的信息，可以用 `web_search` 简单查一下，查到的结果直接融进总结里。

## 3. 写总结

形式完全由这个视频决定。篇幅、语气、结构、用不用标题、列表、表格、时间线、引用原话，都看什么最能把这个视频的内容讲清楚。不要沿用上一次总结的开头和骨架，也不要往固定栏目里填内容。

只有几条底线：

- 依据字稿的真实内容，不能只凭标题和简介。重要的例子、数据、转折、不同人的分歧要留下来。
- 交代材料来源：B站官方字幕（含 AI 字幕 `ai-zh`）还是本地机器转录，不能把机器转录说成官方字幕。机器转录里听不清、可能识别错的专有名词，要标出来或联网确认。
- 结尾给出 `/tmp/bvsum/<BV号>/` 路径，说明重启后会清空。

## 遇到问题

- 视频需要登录、付费或只开放预览：说明能访问的范围，不要假装总结了完整视频。
- 不要索取用户的 Cookie，除非用户明确提出。
- 缺 ffmpeg / uvx：告诉用户 `brew install ffmpeg uv`。
- `web_search` 不可用（没装 websearch 扩展或没登录 OpenAI Codex）：照常总结。
