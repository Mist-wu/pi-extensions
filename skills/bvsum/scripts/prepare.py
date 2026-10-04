#!/usr/bin/env python3
"""Download audio and prepare official subtitles or a local transcript for a Bilibili video.

Output goes to /tmp/bvsum/<BV号>/ (cleared on reboot).

Usage:
  python3 prepare.py URL_OR_BVID [--language auto|zh|en] [--force] [--no-audio]
"""

from __future__ import annotations

import argparse
import fcntl
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

API = "https://api.bilibili.com"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138 Safari/537.36"
DEFAULT_OUTPUT = Path("/tmp/bvsum")
MLX_MODEL = "mlx-community/whisper-small-mlx"
MLX_CACHE = Path.home() / ".cache" / "huggingface" / "hub" / "models--mlx-community--whisper-small-mlx"
WHISPER_CPP_MODEL = Path.home() / ".cache" / "whisper" / "ggml-small-q5_1.bin"


def log(message: str) -> None:
    print(f"[bvsum] {message}", file=sys.stderr, flush=True)


def extract_bvid(value: str) -> str:
    match = re.search(r"BV[0-9A-Za-z]{10}", value)
    if not match:
        raise ValueError("未找到有效 BV 号；请传入 Bilibili URL 或 BVxxxxxxxxxx")
    return match.group(0)


def requested_page(value: str) -> int | None:
    try:
        parsed = urllib.parse.urlparse(value)
        raw = urllib.parse.parse_qs(parsed.query).get("p", [None])[0]
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


def request_bytes(url: str, *, referer: str = "https://www.bilibili.com/", retries: int = 3) -> bytes:
    headers = {"User-Agent": UA, "Referer": referer, "Accept": "*/*"}
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"请求失败：{url} ({last_error})")


def request_json(url: str, *, referer: str = "https://www.bilibili.com/") -> dict[str, Any]:
    try:
        payload = json.loads(request_bytes(url, referer=referer).decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"接口未返回 JSON：{url}") from exc
    if isinstance(payload, dict) and "code" in payload and payload.get("code") != 0:
        raise RuntimeError(f"B站接口错误 {payload.get('code')}：{payload.get('message', '')}")
    return payload


def api_url(path: str, **params: Any) -> str:
    return f"{API}{path}?{urllib.parse.urlencode(params)}"


def fetch_info(bvid: str) -> dict[str, Any]:
    payload = request_json(api_url("/x/web-interface/view", bvid=bvid))
    data = payload.get("data") or {}
    if not data:
        raise RuntimeError("视频元数据为空，可能不存在或需要权限")
    return data


def fetch_player(bvid: str, cid: int) -> dict[str, Any]:
    payload = request_json(api_url("/x/player/v2", bvid=bvid, cid=cid))
    return payload.get("data") or {}


def normalize_url(url: str) -> str:
    if url.startswith("//"):
        return "https:" + url
    return url


def timestamp(seconds: float, sep: str = ",") -> str:
    millis = max(0, round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{millis:03d}"


def choose_subtitle(subtitles: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not subtitles:
        return None
    preferences = ("zh-CN", "zh-Hans", "ai-zh", "zh", "en")
    for lang in preferences:
        for subtitle in subtitles:
            if str(subtitle.get("lan", "")).lower() == lang.lower():
                return subtitle
    return subtitles[0]


def save_official_subtitle(subtitle: dict[str, Any], prefix: Path) -> tuple[Path, Path]:
    raw_url = subtitle.get("subtitle_url") or subtitle.get("subtitleUrl")
    if not raw_url:
        raise RuntimeError("字幕条目缺少下载地址")
    payload = json.loads(request_bytes(normalize_url(str(raw_url))).decode("utf-8"))
    body = payload.get("body") or []
    if not body:
        raise RuntimeError("官方字幕正文为空")

    lang = re.sub(r"[^0-9A-Za-z_-]+", "-", str(subtitle.get("lan") or "unknown"))
    txt_path = prefix.with_name(prefix.name + f".official.{lang}.txt")
    srt_path = prefix.with_name(prefix.name + f".official.{lang}.srt")

    lines: list[str] = []
    srt: list[str] = []
    for index, item in enumerate(body, 1):
        content = html.unescape(str(item.get("content", ""))).strip()
        if not content:
            continue
        lines.append(content)
        srt.extend([
            str(index),
            f"{timestamp(float(item.get('from', 0)))} --> {timestamp(float(item.get('to', 0)))}",
            content,
            "",
        ])
    txt_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    srt_path.write_text("\n".join(srt), encoding="utf-8")
    return txt_path, srt_path


def fetch_audio_candidates(bvid: str, cid: int) -> list[str]:
    endpoints = ("/x/player/wbi/playurl", "/x/player/playurl")
    last_error: Exception | None = None
    for endpoint in endpoints:
        try:
            payload = request_json(api_url(endpoint, bvid=bvid, cid=cid, fnval=4048, fourk=1))
            audio = ((payload.get("data") or {}).get("dash") or {}).get("audio") or []
            if not audio:
                continue
            best = max(audio, key=lambda item: int(item.get("bandwidth") or 0))
            urls = [best.get("baseUrl") or best.get("base_url")]
            urls.extend(best.get("backupUrl") or best.get("backup_url") or [])
            return [normalize_url(str(url)) for url in urls if url]
        except Exception as exc:  # try the non-WBI public endpoint next
            last_error = exc
    raise RuntimeError(f"没有可访问的 DASH 音频（可能需要登录、付费或仅开放预览）：{last_error}")


def download_file(urls: list[str], destination: Path, referer: str) -> None:
    last_error: Exception | None = None
    for url in urls:
        try:
            headers = {"User-Agent": UA, "Referer": referer, "Accept": "*/*"}
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=90) as response, destination.open("wb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
            if destination.stat().st_size < 1024:
                raise RuntimeError("下载文件异常地小")
            return
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError) as exc:
            last_error = exc
            destination.unlink(missing_ok=True)
    raise RuntimeError(f"音频下载失败：{last_error}")


def save_audio(bvid: str, cid: int, page: dict[str, Any], page_number: int, prefix: Path) -> tuple[Path, float]:
    audio_path = prefix.with_suffix(".m4a")
    if audio_path.exists() and audio_path.stat().st_size > 0:
        log(f"复用已有音频：{audio_path}")
        return audio_path, ffprobe_duration(audio_path)

    referer = f"https://www.bilibili.com/video/{bvid}/?p={page_number}"
    with tempfile.TemporaryDirectory(prefix=f"bvsum-{bvid}-p{page_number}-") as temp:
        raw_audio = Path(temp) / "audio.m4s"
        log("下载公开 DASH 音频…")
        download_file(fetch_audio_candidates(bvid, cid), raw_audio, referer)
        actual_duration = ffprobe_duration(raw_audio)
        expected_duration = float(page.get("duration") or 0)
        if expected_duration and abs(actual_duration - expected_duration) > max(8, expected_duration * 0.05):
            raise RuntimeError(
                f"音频时长不完整：下载 {actual_duration:.1f}s，页面标注 {expected_duration:.1f}s"
            )
        subprocess.run(
            [require_binary("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw_audio),
             "-vn", "-c:a", "copy", str(audio_path)],
            check=True,
        )
    return audio_path, actual_duration


def require_binary(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"缺少依赖：{name}")
    return path


def ffprobe_duration(path: Path) -> float:
    result = subprocess.run(
        [require_binary("ffprobe"), "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def convert_to_wav(source: Path, destination: Path) -> None:
    subprocess.run(
        [require_binary("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
         "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(destination)],
        check=True,
    )


def select_backend(requested: str) -> str:
    if requested != "auto":
        return requested
    if shutil.which("uvx") and MLX_CACHE.exists():
        return "mlx"
    if shutil.which("whisper-cli") and WHISPER_CPP_MODEL.exists():
        return "whisper-cpp"
    if shutil.which("uvx"):
        return "mlx"
    raise RuntimeError("未找到转录后端：需要 uvx + mlx-whisper，或 whisper-cli + 本地模型")


def run_logged(command: list[str], log_path: Path) -> None:
    with log_path.open("w", encoding="utf-8") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, text=True)
    if result.returncode != 0:
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
        raise RuntimeError(f"转录命令失败（退出码 {result.returncode}）：\n{tail}")
    log_path.unlink(missing_ok=True)


def transcribe_mlx(wav: Path, prefix: Path, language: str) -> None:
    command = [
        require_binary("uvx"), "--from", "mlx-whisper", "mlx_whisper", str(wav),
        "--model", MLX_MODEL,
        "--task", "transcribe",
        "--output-format", "all",
        "--output-name", prefix.name,
        "--output-dir", str(prefix.parent),
        "--condition-on-previous-text", "False",
    ]
    if language != "auto":
        command.extend(["--language", language])
    run_logged(command, prefix.with_suffix(".transcribe.log"))


def transcribe_whisper_cpp(wav: Path, prefix: Path, language: str) -> None:
    require_binary("whisper-cli")
    if not WHISPER_CPP_MODEL.exists():
        raise RuntimeError(f"本地 whisper.cpp 模型不存在：{WHISPER_CPP_MODEL}")
    command = [
        "whisper-cli", "-m", str(WHISPER_CPP_MODEL), "-f", str(wav),
        "-l", language, "-otxt", "-osrt", "-ovtt", "-oj", "-of", str(prefix), "-np",
    ]
    run_logged(command, prefix.with_suffix(".transcribe.log"))


def existing_transcript(prefix: Path) -> Path | None:
    txt = prefix.with_suffix(".txt")
    return txt if txt.exists() and txt.stat().st_size > 0 else None


def transcribe(wav: Path, prefix: Path, language: str, backend_request: str) -> str:
    backend = select_backend(backend_request)
    log(f"本地转录：backend={backend}, language={language}")
    try:
        if backend == "mlx":
            transcribe_mlx(wav, prefix, language)
        else:
            transcribe_whisper_cpp(wav, prefix, language)
        return backend
    except Exception as first_error:
        if backend_request == "auto" and backend == "mlx" and shutil.which("whisper-cli") and WHISPER_CPP_MODEL.exists():
            log(f"MLX 转录失败，改用 whisper-cli：{first_error}")
            transcribe_whisper_cpp(wav, prefix, language)
            return "whisper-cpp"
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="为 Bilibili 视频准备官方字幕或本地转录")
    parser.add_argument("input", help="Bilibili URL 或 BV号")
    parser.add_argument("--language", choices=("auto", "zh", "en"), default="auto")
    parser.add_argument("--backend", choices=("auto", "mlx", "whisper-cpp"), default="auto")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--force", action="store_true", help="忽略已有机器字稿并重新转录")
    parser.add_argument("--metadata-only", action="store_true", help="只获取元数据，不下载或转录")
    parser.add_argument("--no-audio", action="store_true", help="有官方字幕时不下载音频")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        bvid = extract_bvid(args.input)
    except ValueError as exc:
        log(str(exc))
        return 2

    output_dir = (args.output_dir.expanduser() / bvid).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / f"{bvid}.bvsum.json"
    lock_path = Path(tempfile.gettempdir()) / f"bvsum-{bvid}.lock"

    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log(f"同一视频已有 bvsum 任务运行：{bvid}")
            return 3

        try:
            info = fetch_info(bvid)
            all_pages = info.get("pages") or [{"cid": info.get("cid"), "page": 1, "part": info.get("title", "")}]
            selected = requested_page(args.input)
            pages = [p for p in all_pages if int(p.get("page") or 1) == selected] if selected else all_pages
            if not pages:
                raise RuntimeError(f"链接指定的分P不存在：p={selected}")

            manifest: dict[str, Any] = {
                "bvid": bvid,
                "title": info.get("title", ""),
                "owner": (info.get("owner") or {}).get("name", ""),
                "description": info.get("desc", ""),
                "duration_seconds": info.get("duration", 0),
                "pubdate": time.strftime("%Y-%m-%d", time.localtime(info.get("pubdate") or 0)),
                "url": f"https://www.bilibili.com/video/{bvid}/",
                "selected_page": selected,
                "pages": [],
            }
            log(f"{manifest['title']} | UP主：{manifest['owner']} | {manifest['duration_seconds']} 秒")

            if args.metadata_only:
                for page in pages:
                    manifest["pages"].append({
                        "page": page.get("page", 1), "cid": page.get("cid"),
                        "title": page.get("part", ""), "duration_seconds": page.get("duration", 0),
                    })
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                print(manifest_path)
                return 0

            for page_index, page in enumerate(pages, 1):
                page_number = int(page.get("page") or page_index)
                cid = int(page.get("cid") or 0)
                if not cid:
                    raise RuntimeError(f"P{page_number} 缺少 cid")
                prefix_name = bvid if len(all_pages) == 1 else f"{bvid}_p{page_number:02d}"
                prefix = output_dir / prefix_name
                page_result: dict[str, Any] = {
                    "page": page_number,
                    "cid": cid,
                    "title": page.get("part", ""),
                    "duration_seconds": page.get("duration", 0),
                }
                log(f"处理 P{page_number}：{page_result['title']}")

                player = fetch_player(bvid, cid)
                page_result["chapters"] = player.get("view_points") or []
                subtitles = ((player.get("subtitle") or {}).get("subtitles") or [])
                official = choose_subtitle(subtitles)
                if official:
                    try:
                        txt_path, srt_path = save_official_subtitle(official, prefix)
                        page_result.update({
                            "source": "official-subtitle",
                            "language": official.get("lan"),
                            "transcript_path": str(txt_path),
                            "srt_path": str(srt_path),
                        })
                        log(f"使用 B站官方字幕：{txt_path}")
                        if not args.no_audio:
                            try:
                                audio_path, duration = save_audio(bvid, cid, page, page_number, prefix)
                                page_result["audio_path"] = str(audio_path)
                                page_result["audio_duration_seconds"] = round(duration, 3)
                            except Exception as exc:
                                log(f"音频下载失败（字幕已就绪，继续）：{exc}")
                        manifest["pages"].append(page_result)
                        continue
                    except Exception as exc:
                        log(f"官方字幕不可下载，回退本地转录：{exc}")

                prior = existing_transcript(prefix)
                if prior and not args.force:
                    page_result.update({
                        "source": "existing-machine-transcript",
                        "language": args.language,
                        "transcript_path": str(prior),
                        "srt_path": str(prefix.with_suffix('.srt')) if prefix.with_suffix('.srt').exists() else None,
                    })
                    audio = prefix.with_suffix(".m4a")
                    if audio.exists():
                        page_result["audio_path"] = str(audio)
                    log(f"复用已有机器字稿：{prior}")
                    manifest["pages"].append(page_result)
                    continue

                audio_path, duration = save_audio(bvid, cid, page, page_number, prefix)
                page_result["audio_path"] = str(audio_path)
                page_result["audio_duration_seconds"] = round(duration, 3)
                with tempfile.TemporaryDirectory(prefix=f"bvsum-{bvid}-p{page_number}-") as temp:
                    wav_audio = Path(temp) / "audio.wav"
                    convert_to_wav(audio_path, wav_audio)
                    used_backend = transcribe(wav_audio, prefix, args.language, args.backend)

                transcript_path = existing_transcript(prefix)
                if not transcript_path:
                    raise RuntimeError("转录进程结束但未生成 TXT")
                page_result.update({
                    "source": "machine-transcript",
                    "backend": used_backend,
                    "language": args.language,
                    "transcript_path": str(transcript_path),
                    "srt_path": str(prefix.with_suffix('.srt')) if prefix.with_suffix('.srt').exists() else None,
                })
                manifest["pages"].append(page_result)
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            log(f"音频与字稿保存在 {output_dir}（重启后自动清空）")
            print(manifest_path)
            return 0
        except Exception as exc:
            log(f"ERROR: {exc}")
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
