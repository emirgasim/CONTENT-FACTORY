import tempfile
import unittest
from pathlib import Path

from editing_agent import (
    build_edit_plan,
    build_visual_beats,
    remap_rows_to_edited_timeline,
    write_ass_subtitles,
)


class EditingAgentTests(unittest.TestCase):
    def setUp(self):
        self.words = [
            {"start": 0.15, "end": 0.45, "text": "Önce"},
            {"start": 0.47, "end": 0.75, "text": "hikâye."},
            {"start": 1.80, "end": 2.10, "text": "Sonra"},
            {"start": 2.12, "end": 2.45, "text": "gerçek."},
        ]

    def test_long_sentence_gap_is_tightened_and_short_gap_is_kept(self):
        plan = build_edit_plan(self.words, 3.0)
        self.assertEqual(len(plan["cuts"]), 1)
        self.assertAlmostEqual(plan["cuts"][0]["kept_gap"], 0.16, places=2)
        self.assertGreater(plan["removed_seconds"], 0.7)

    def test_word_times_are_remapped_after_removed_pause(self):
        plan = build_edit_plan(self.words, 3.0)
        remapped = remap_rows_to_edited_timeline(self.words, plan)
        self.assertEqual(len(remapped), len(self.words))
        self.assertLess(remapped[2]["start"], self.words[2]["start"])
        self.assertGreater(remapped[2]["start"], remapped[1]["end"])

    def test_visual_beats_are_contiguous_and_keep_sentence_text(self):
        plan = build_edit_plan(self.words, 3.0)
        remapped = remap_rows_to_edited_timeline(self.words, plan)
        beats = build_visual_beats(remapped, plan["output_duration"])
        self.assertEqual(len(beats), 2)
        self.assertAlmostEqual(beats[0]["start"], 0.0)
        self.assertAlmostEqual(beats[0]["end"], beats[1]["start"])
        self.assertAlmostEqual(beats[-1]["end"], plan["output_duration"])
        self.assertIn("hikâye.", beats[0]["text"])

    def test_ass_caption_file_has_timed_dialogue(self):
        beats = build_visual_beats(self.words, 3.0)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "captions.ass"
            write_ass_subtitles(beats, target)
            rendered = target.read_text(encoding="utf-8")
            self.assertIn("[Events]", rendered)
            self.assertIn("Dialogue:", rendered)
            self.assertIn("hikâye.", rendered)
            self.assertIn("DejaVu Sans,64", rendered)


if __name__ == "__main__":
    unittest.main()
