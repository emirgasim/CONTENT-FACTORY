from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

from animated_scene_renderer import caption_lines, infer_kind, render_animated_video


class AnimatedSceneRendererTests(unittest.TestCase):
    def test_subject_classifier_uses_the_narration_subject(self) -> None:
        self.assertEqual(infer_kind("Pac-Man 256. seviyeye ulaştı."), "pacman")
        self.assertEqual(infer_kind("Minecraft dünyasında yeni bir blok"), "minecraft")
        self.assertEqual(infer_kind("Galaksinin dışında bir gezegen"), "space")
        self.assertEqual(infer_kind("Bu ayrıntının arkasındaki gizem"), "mystery")

    def test_scene_caption_is_limited_to_three_readable_lines(self) -> None:
        lines = caption_lines(
            "BU GİZLİ AYRINTI YILLARCA KİMSE TARAFINDAN FARK EDİLMEDİ",
            max_chars=20,
            max_lines=3,
        )
        self.assertGreaterEqual(len(lines), 1)
        self.assertLessEqual(len(lines), 3)
        self.assertTrue(lines[-1])

    def test_renderer_creates_vertical_mp4_without_any_stock_assets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cf-animation-test-") as folder:
            root = Path(folder)
            audio = root / "silence.wav"
            with wave.open(str(audio), "wb") as stream:
                stream.setnchannels(2)
                stream.setsampwidth(2)
                stream.setframerate(44100)
                stream.writeframes(b"\0\0\0\0" * 44100 * 2)
            output = root / "animation.mp4"
            render_animated_video(
                scenes=[
                    {"index": 1, "duration": 1.0, "text": "PAC MAN GİZEMİ", "visual_kind": "pacman"},
                    {"index": 2, "duration": 1.0, "text": "MINECRAFT DÜNYASI", "visual_kind": "minecraft"},
                ],
                voice_audio_path=str(audio),
                output_mp4_path=str(output),
                duration=2.0,
                context="retro oyunlar",
            )
            self.assertGreater(output.stat().st_size, 2048)
            probe = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-show_entries",
                    "stream=codec_name,width,height", "-of", "json", str(output),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            streams = json.loads(probe.stdout)["streams"]
            video = next(item for item in streams if item["codec_name"] == "h264")
            self.assertEqual((video["width"], video["height"]), (1080, 1920))


if __name__ == "__main__":
    unittest.main()
