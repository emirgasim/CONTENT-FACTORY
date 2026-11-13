"""Dynamic sentence-aware scene segmentation without fixed upper duration caps."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class SceneSegment:
    index: int
    start: float
    end: float
    duration: float
    text: str
    words: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "duration": round(self.duration, 3),
            "text": self.text,
            "words": self.words,
        }


SENTENCE_ENDINGS = (".", "!", "?", "…")


def build_sentence_scenes(
    words: list[dict[str, Any]],
    total_duration: float | None = None,
    pause_threshold: float = 0.55,
    min_scene_seconds: float = 0.8,
) -> list[SceneSegment]:
    """
    Group word timestamps into coherent sentence/clause scenes without cutting
    sentences mid-way or imposing a fixed upper duration limit.
    """
    cleaned = [
        {
            "word": str(w.get("word", "")).strip(),
            "start": float(w.get("start", 0.0)),
            "end": float(w.get("end", 0.0)),
        }
        for w in words
        if str(w.get("word", "")).strip()
    ]
    if not cleaned:
        return []

    raw_groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []

    for idx, word in enumerate(cleaned):
        current.append(word)
        token = word["word"]
        ends_sentence = token.endswith(SENTENCE_ENDINGS)

        next_gap = 0.0
        if idx + 1 < len(cleaned):
            next_gap = max(0.0, cleaned[idx + 1]["start"] - word["end"])

        cur_dur = word["end"] - current[0]["start"]

        # Split only at a sentence boundary or a meaningful narration pause
        # once minimum readability duration is met; never impose a fixed max cap.
        should_split = False
        if idx == len(cleaned) - 1:
            should_split = True
        elif ends_sentence and cur_dur >= min_scene_seconds:
            should_split = True
        elif next_gap >= pause_threshold and cur_dur >= min_scene_seconds and not token.endswith(","):
            should_split = True

        if should_split:
            raw_groups.append(current)
            current = []

    if current:
        raw_groups.append(current)

    # Eliminate dead air between scenes by meeting at the midpoint of pauses
    scenes: list[SceneSegment] = []
    for i, group in enumerate(raw_groups):
        if i == 0:
            start = 0.0
        else:
            prev_end = raw_groups[i - 1][-1]["end"]
            cur_start = group[0]["start"]
            start = (prev_end + cur_start) / 2.0

        if i == len(raw_groups) - 1:
            end = max(group[-1]["end"], float(total_duration or group[-1]["end"]))
        else:
            next_start = raw_groups[i + 1][0]["start"]
            end = (group[-1]["end"] + next_start) / 2.0

        end = max(end, start + 0.4)
        text = " ".join(w["word"] for w in group).strip()
        scenes.append(
            SceneSegment(
                index=i + 1,
                start=start,
                end=end,
                duration=end - start,
                text=text,
                words=group,
            )
        )

    return scenes
