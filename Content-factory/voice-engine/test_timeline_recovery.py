import unittest

import cloud_worker


class TimelineRecoveryTests(unittest.TestCase):
    def test_valid_word_timestamps_create_multiple_beats(self):
        rows = [
            {"start": 0.10, "end": 0.30, "text": "Rocky"},
            {"start": 0.31, "end": 0.55, "text": "Balboa"},
            {"start": 0.60, "end": 0.90, "text": "efsanesiydi."},
            {"start": 1.10, "end": 1.35, "text": "Stallone"},
            {"start": 1.36, "end": 1.70, "text": "köpeğini"},
            {"start": 1.71, "end": 2.00, "text": "geri",
             },
            {"start": 2.01, "end": 2.25, "text": "aldı."},
        ]
        groups = cloud_worker.build_audio_scene_groups(rows, 2.5)
        self.assertTrue(groups)
        self.assertIn("Rocky", " ".join(x["text"] for x in groups))
        self.assertAlmostEqual(groups[-1]["end"], 2.5, places=2)

    def test_invalid_word_timestamps_fall_back_to_transcript(self):
        rows = [
            {"start": 0.0, "end": 0.0, "text": "Rocky"},
            {"start": 99.0, "end": 100.0, "text": "Balboa"},
            {"start": -1.0, "end": -0.5, "text": "efsanesiydi."},
        ]
        groups = cloud_worker.build_audio_scene_groups(rows, 12.0)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["start"], 0.0)
        self.assertEqual(groups[0]["end"], 12.0)
        self.assertIn("Rocky Balboa efsanesiydi.", groups[0]["text"])

    def test_empty_transcript_fails_cleanly(self):
        self.assertEqual(cloud_worker.build_audio_scene_groups([], 12.0), [])
        self.assertEqual(cloud_worker.build_audio_scene_groups(
            [{"start": 0, "end": 0, "text": "  "}], 12.0
        ), [])

    def test_long_narration_keeps_all_words_and_positive_scene_durations(self):
        script = ("Rocky Balboa hikâyesi İstanbul'da başladı. " * 900).strip()
        groups = cloud_worker.make_text_groups(script)
        self.assertGreater(len(groups), 100)
        self.assertTrue(all(x["end"] > x["start"] for x in groups))
        self.assertIn("İstanbul'da", " ".join(x["text"] for x in groups))
        self.assertIn("başladı.", " ".join(x["text"] for x in groups))


if __name__ == "__main__":
    unittest.main()
