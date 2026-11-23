#!/usr/bin/env python3
"""Regression tests for bvsum transcript publish. Uses synthetic files only."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import prepare


class TranscriptPublishTest(unittest.TestCase):
    def test_old_flat_transcript_remains_reusable(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            prefix = Path(raw) / "BV1oldformat0"
            prefix.with_suffix(".txt").write_text("旧字稿\n", encoding="utf-8")
            prefix.with_suffix(".srt").write_text("1\nold\n", encoding="utf-8")
            found = prepare.existing_transcript(prefix)
            self.assertEqual(found, prefix.with_suffix(".txt"))
            self.assertEqual(found.read_text(encoding="utf-8"), "旧字稿\n")

    def test_interrupted_second_install_restores_the_previous_set(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            prefix = root / "BV1mixedset01"
            prefix.with_suffix(".txt").write_text("OLD\n", encoding="utf-8")
            prefix.with_suffix(".srt").write_text("OLD-SRT\n", encoding="utf-8")
            staged_dir = root / "staged"
            staged_dir.mkdir()
            staged = staged_dir / prefix.name
            staged.with_suffix(".txt").write_text("NEW\n", encoding="utf-8")
            staged.with_suffix(".srt").write_text("NEW-SRT\n", encoding="utf-8")
            installs = {"count": 0}
            original = prepare.replace_file

            def interrupt_second_install(source: Path, target: Path) -> None:
                if target.parent == prefix.parent and target.suffix in {".txt", ".srt"}:
                    installs["count"] += 1
                    if installs["count"] == 2:
                        raise KeyboardInterrupt
                original(source, target)

            prepare.replace_file = interrupt_second_install
            try:
                with self.assertRaises(KeyboardInterrupt):
                    prepare.publish_transcript(prefix, staged)
            finally:
                prepare.replace_file = original

            self.assertTrue(prepare._journal_path(prefix).exists())
            reused = prepare.existing_transcript(prefix)
            self.assertEqual(reused, prefix.with_suffix(".txt"))
            self.assertEqual(prefix.with_suffix(".txt").read_text(encoding="utf-8"), "OLD\n")
            self.assertEqual(prefix.with_suffix(".srt").read_text(encoding="utf-8"), "OLD-SRT\n")
            self.assertFalse(prepare._journal_path(prefix).exists())

    def test_publish_keeps_only_the_successful_backend_directory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            prefix = root / "BV1backend01"
            mlx = root / "mlx" / prefix.name
            mlx.parent.mkdir()
            mlx.with_suffix(".tsv").write_text("mlx leftover\n", encoding="utf-8")
            whisper = root / "whisper-cpp" / prefix.name
            whisper.parent.mkdir()
            whisper.with_suffix(".txt").write_text("whisper\n", encoding="utf-8")
            published = prepare.publish_transcript(prefix, whisper)
            self.assertEqual(published[".txt"].read_text(encoding="utf-8"), "whisper\n")
            self.assertFalse(prefix.with_suffix(".tsv").exists())
            self.assertNotIn(".srt", published)

    def test_stale_srt_without_txt_is_not_part_of_the_new_manifest_set(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            prefix = root / "BV1stalesrt1"
            prefix.with_suffix(".srt").write_text("STALE\n", encoding="utf-8")
            staged = root / "backend" / prefix.name
            staged.parent.mkdir()
            staged.with_suffix(".txt").write_text("fresh\n", encoding="utf-8")
            self.assertIsNone(prepare.existing_transcript(prefix))
            published = prepare.publish_transcript(prefix, staged)
            self.assertEqual(set(published), {".txt"})
            self.assertFalse(prefix.with_suffix(".srt").exists())
            self.assertEqual(prefix.with_suffix(".txt").read_text(encoding="utf-8"), "fresh\n")

    def test_keyboard_interrupt_cleans_the_audio_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            workspace = Path(raw) / "work"
            workspace.mkdir()
            wav = workspace / "audio.wav"
            wav.write_bytes(b"RIFF")
            try:
                try:
                    raise KeyboardInterrupt
                finally:
                    prepare.cleanup_audio_workspace(wav, workspace)
            except KeyboardInterrupt:
                pass
            self.assertFalse(wav.exists())
            self.assertFalse(workspace.exists())


if __name__ == "__main__":
    unittest.main()
