import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scene_segmentation import build_sentence_scenes
from timeline_renderer import render_timeline_mp4


class TestPipeline(unittest.TestCase):
    def test_sentence_segmentation_no_hard_cap(self):
        words = [
            {"word": "Yapay", "start": 0.1, "end": 0.5},
            {"word": "zeka", "start": 0.55, "end": 0.9},
            {"word": "sistemleri", "start": 0.95, "end": 1.6},
            {"word": "artık", "start": 1.65, "end": 2.1},
            {"word": "uzun", "start": 2.15, "end": 2.6},
            {"word": "cümleleri", "start": 2.65, "end": 3.4},
            {"word": "kesmeden", "start": 3.45, "end": 4.2},
            {"word": "işliyor.", "start": 4.25, "end": 5.1},
            {"word": "İkinci", "start": 5.8, "end": 6.2},
            {"word": "sahne", "start": 6.25, "end": 6.7},
            {"word": "başladı.", "start": 6.75, "end": 7.4},
        ]
        scenes = build_sentence_scenes(words, total_duration=7.6)
        self.assertEqual(len(scenes), 2)
        # First sentence is > 5 seconds and was NOT artificially capped at 2.8s
        self.assertGreater(scenes[0].duration, 5.0)
        self.assertEqual(scenes[0].end, scenes[1].start)  # Zero dead-air gap

    def test_real_ffmpeg_timeline_render(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            img1 = tmp_dir / "s1.png"
            img2 = tmp_dir / "s2.png"
            voice = tmp_dir / "voice.wav"
            music = tmp_dir / "music.wav"
            out_mp4 = tmp_dir / "out.mp4"

            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#1e3a8a:s=1080x1920:d=1", "-frames:v", "1", str(img1)],
                check=True,
            )
            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=#7c2d12:s=1280x720:d=1", "-frames:v", "1", str(img2)],
                check=True,
            )
            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4.5", "-c:a", "pcm_s16le", str(voice)],
                check=True,
            )
            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=5.0", "-c:a", "pcm_s16le", str(music)],
                check=True,
            )

            scenes = [
                {
                    "order": 2,
                    "scene": 1,
                    "image_path": str(img1),
                    "duration": 2.2,
                    "text": "İkinci sırada render edildi",
                    "transition": "dissolve",
                    "framing": {"scale": 1.2, "panX": 5, "panY": -5},
                },
                {
                    "order": 1,
                    "scene": 2,
                    "image_path": str(img2),
                    "duration": 2.5,
                    "text": "İlk sahne başa alındı",
                    "transition": "cut",
                    "framing": {"scale": 1.1, "panX": 0, "panY": 0},
                },
            ]

            result = render_timeline_mp4(
                scenes=scenes,
                voice_audio_path=str(voice),
                music_audio_path=str(music),
                output_mp4_path=str(out_mp4),
                audio_mix={"voiceVolume": 1.0, "musicVolume": 0.2},
            )
            self.assertTrue(result.exists())
            self.assertGreater(result.stat().st_size, 5000)

            probe = subprocess.check_output(
                ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", str(result)],
                text=True,
            )
            info = json.loads(probe)
            streams = {s["codec_type"]: s for s in info["streams"]}
            self.assertEqual(streams["video"]["width"], 1080)
            self.assertEqual(streams["video"]["height"], 1920)
            self.assertEqual(streams["video"]["codec_name"], "h264")
            self.assertEqual(streams["audio"]["codec_name"], "aac")


if __name__ == "__main__":
    unittest.main()
