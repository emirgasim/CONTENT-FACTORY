"""Deterministic AI editing decisions for short-form narration.

The agent uses word timestamps as the source of truth, shortens only long
inter-word gaps, remaps every timestamp onto the edited audio timeline, and
creates phrase-level caption/visual beats. No external API or extra model is
required at render time.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any


def _clean_rows(rows: list[dict[str, Any]], duration: float) -> list[dict[str, Any]]:
    clean: list[dict[str, Any]] = []
    for row in rows or []:
        try:
            start = max(0.0, min(duration, float(row.get("start", 0.0))))
            end = max(start, min(duration, float(row.get("end", start))))
            text = re.sub(r"\s+", " ", str(row.get("text", "")).strip())
        except (TypeError, ValueError):
            continue
        if text and end > start:
            clean.append({"start": start, "end": end, "text": text})
    return sorted(clean, key=lambda item: (item["start"], item["end"]))


def build_edit_plan(
    rows: list[dict[str, Any]],
    duration: float,
    *,
    min_sentence_gap: float = 0.42,
    min_phrase_gap: float = 0.58,
    sentence_keep: float = 0.16,
    phrase_keep: float = 0.22,
    head_padding: float = 0.08,
    tail_padding: float = 0.12,
) -> dict[str, Any]:
    """Create an edit-decision list that tightens long pauses without chopping speech."""
    if duration <= 0:
        raise ValueError("Audio duration must be positive.")
    words = _clean_rows(rows, duration)
    if not words:
        spans = [{"start": 0.0, "end": duration}]
        return {
            "version": 1, "strategy": "no-word-timestamps",
            "source_duration": duration, "output_duration": duration,
            "removed_seconds": 0.0, "cuts": [], "spans": spans,
            "decisions": [],
        }

    first = words[0]
    last = words[-1]
    start_bound = max(0.0, first["start"] - head_padding)
    end_bound = min(duration, last["end"] + tail_padding)
    if end_bound <= start_bound:
        start_bound, end_bound = 0.0, duration

    cuts: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    for left, right in zip(words, words[1:]):
        gap = right["start"] - left["end"]
        if gap <= 0:
            continue
        sentence_break = any(left["text"].endswith(mark) for mark in (".", "!", "?", "…"))
        threshold = min_sentence_gap if sentence_break else min_phrase_gap
        kept_gap = sentence_keep if sentence_break else phrase_keep
        if gap <= threshold or gap <= kept_gap + 0.04:
            continue

        # Keep a short natural bridge at both sides of the cut. The centre of
        # the detected pause is removed; word boundaries are never intentionally cut.
        left_keep = min(kept_gap / 2.0, max(0.025, gap * 0.2))
        right_keep = min(kept_gap - left_keep, max(0.025, gap * 0.2))
        cut_start = max(left["end"], left["end"] + left_keep)
        cut_end = min(right["start"], right["start"] - right_keep)
        if cut_end - cut_start < 0.04:
            continue
        cuts.append({"start": cut_start, "end": cut_end, "gap": gap, "kept_gap": gap - (cut_end - cut_start), "reason": "sentence_pause" if sentence_break else "long_internal_pause"})
        decisions.append({
            "type": "tighten_pause",
            "from": round(left["end"], 3),
            "to": round(right["start"], 3),
            "original_gap": round(gap, 3),
            "kept_gap": round(gap - (cut_end - cut_start), 3),
            "reason": "sentence_pause" if sentence_break else "long_internal_pause",
        })

    # Leading/trailing dead air is removed while retaining a tiny natural handle.
    if start_bound > 0.02:
        decisions.append({"type": "trim_leading", "seconds": round(start_bound, 3)})
    if duration - end_bound > 0.02:
        decisions.append({"type": "trim_trailing", "seconds": round(duration - end_bound, 3)})

    spans: list[dict[str, float]] = []
    cursor = start_bound
    for cut in cuts:
        cut_start = max(cursor, cut["start"])
        cut_end = min(end_bound, cut["end"])
        if cut_start - cursor >= 0.025:
            spans.append({"start": cursor, "end": cut_start})
        cursor = max(cursor, cut_end)
    if end_bound - cursor >= 0.025:
        spans.append({"start": cursor, "end": end_bound})
    if not spans:
        spans = [{"start": 0.0, "end": duration}]
        cuts = []
        decisions = [{"type": "keep_original", "reason": "no_safe_edit_spans"}]

    output_duration = sum(span["end"] - span["start"] for span in spans)
    return {
        "version": 1,
        "strategy": "word-timestamp-aware-dynamic-pacing",
        "source_duration": round(duration, 6),
        "output_duration": round(output_duration, 6),
        "removed_seconds": round(max(0.0, duration - output_duration), 6),
        "cuts": cuts,
        "spans": spans,
        "decisions": decisions,
        "parameters": {
            "sentence_gap_threshold": min_sentence_gap,
            "phrase_gap_threshold": min_phrase_gap,
            "sentence_pause_target": sentence_keep,
            "phrase_pause_target": phrase_keep,
            "head_padding": head_padding,
            "tail_padding": tail_padding,
        },
    }


def remap_rows_to_edited_timeline(
    rows: list[dict[str, Any]], plan: dict[str, Any]
) -> list[dict[str, Any]]:
    """Translate original audio timestamps through the kept-span edit decision list."""
    spans = plan.get("spans") or []
    if not spans:
        return _clean_rows(rows, float(plan.get("source_duration", 0.0)))
    clean = _clean_rows(rows, float(plan.get("source_duration", 0.0)))

    def map_time(value: float) -> float:
        elapsed = 0.0
        for span in spans:
            left, right = float(span["start"]), float(span["end"])
            length = right - left
            if value < left:
                return elapsed
            if value <= right:
                return elapsed + max(0.0, min(length, value - left))
            elapsed += length
        return elapsed

    mapped: list[dict[str, Any]] = []
    for row in clean:
        start = map_time(row["start"])
        end = map_time(row["end"])
        if end - start < 0.025:
            continue
        mapped.append({"start": start, "end": end, "text": row["text"]})
    return mapped


def render_edited_audio(source: Path, output: Path, plan: dict[str, Any]) -> None:
    """Render the kept audio spans with FFmpeg atrim/concat and clean timestamps."""
    spans = plan.get("spans") or []
    if not spans:
        raise RuntimeError("Edit decision list contains no audio spans.")
    filters: list[str] = []
    labels: list[str] = []
    for index, span in enumerate(spans):
        label = f"a{index}"
        filters.append(
            f"[0:a]atrim=start={float(span['start']):.6f}:end={float(span['end']):.6f},"
            f"asetpts=PTS-STARTPTS,aresample=48000,"
            f"aformat=sample_fmts=s16:channel_layouts=stereo[{label}]"
        )
        labels.append(f"[{label}]")
    if len(labels) == 1:
        filters.append(f"{labels[0]}anull[outa]")
    else:
        filters.append(f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[outa]")
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-filter_complex", ";".join(filters), "-map", "[outa]", "-vn",
            "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", str(output),
        ],
        capture_output=True, text=True, timeout=300, check=False,
    )
    if result.returncode != 0 or not output.is_file() or output.stat().st_size < 1024:
        raise RuntimeError("Edited audio render failed: " + (result.stderr or "unknown FFmpeg error")[-1000:])


def _expand_word_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    expanded: list[dict[str, Any]] = []
    for row in rows or []:
        text = re.sub(r"\s+", " ", str(row.get("text", "")).strip())
        if not text:
            continue
        try:
            start, end = float(row["start"]), float(row["end"])
        except (KeyError, TypeError, ValueError):
            continue
        tokens = text.split()
        if len(tokens) <= 1:
            expanded.append({"start": start, "end": end, "text": text})
            continue
        weights = [max(1, len(token.strip(".,!?;:…"))) for token in tokens]
        total = sum(weights)
        cursor = start
        for index, (token, weight) in enumerate(zip(tokens, weights)):
            token_end = end if index == len(tokens) - 1 else cursor + (end - start) * weight / total
            expanded.append({"start": cursor, "end": max(cursor + 0.025, token_end), "text": token})
            cursor = token_end
    return sorted(expanded, key=lambda item: item["start"])


def build_visual_beats(
    rows: list[dict[str, Any]],
    duration: float,
    *,
    max_words: int = 7,
    max_seconds: float = 2.8,
) -> list[dict[str, Any]]:
    """Group aligned words into short, readable phrases and contiguous visual shots."""
    words = _expand_word_rows(_clean_rows(rows, duration))
    if not words:
        return [{"start": 0.0, "end": duration, "speech_start": 0.0, "speech_end": duration, "text": ""}]

    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for word in words:
        if current:
            prior = current[-1]
            gap = max(0.0, word["start"] - prior["end"])
            elapsed = word["end"] - current[0]["start"]
            if gap > 0.38 or len(current) >= max_words or elapsed >= max_seconds:
                chunks.append(current)
                current = []
        current.append(word)
        if any(word["text"].endswith(mark) for mark in (".", "!", "?", "…")):
            chunks.append(current)
            current = []
    if current:
        chunks.append(current)

    speech_beats: list[dict[str, Any]] = []
    for chunk in chunks:
        start = max(0.0, chunk[0]["start"])
        end = max(start + 0.04, chunk[-1]["end"])
        text = " ".join(item["text"] for item in chunk)
        speech_beats.append({
            "speech_start": start,
            "speech_end": end,
            "text": text,
            "word_count": len(chunk),
        })

    # Give each visual beat the small silence that follows it, splitting it at
    # the midpoint. This creates a contiguous picture timeline with no black gaps.
    beats: list[dict[str, Any]] = []
    cursor = 0.0
    for index, beat in enumerate(speech_beats):
        if index < len(speech_beats) - 1:
            next_start = speech_beats[index + 1]["speech_start"]
            boundary = max(beat["speech_end"], (beat["speech_end"] + next_start) / 2.0)
        else:
            boundary = duration
        end = max(cursor + 0.04, min(duration, boundary))
        beats.append({
            **beat,
            "start": cursor,
            "end": end,
        })
        cursor = end
    beats[-1]["end"] = duration
    return beats


def _ass_time(seconds: float) -> str:
    value = max(0.0, seconds)
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    whole = int(value % 60)
    centiseconds = int(round((value - int(value)) * 100))
    if centiseconds >= 100:
        whole += 1
        centiseconds = 0
    if whole >= 60:
        minutes += 1
        whole = 0
    if minutes >= 60:
        hours += 1
        minutes = 0
    return f"{hours}:{minutes:02d}:{whole:02d}.{centiseconds:02d}"


def write_ass_subtitles(beats: list[dict[str, Any]], output: Path) -> None:
    """Write phrase-synchronised ASS captions for the bottom safe area of 9:16 video."""
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,64,\u0026H00FFFFFF,\u0026H0000FFFF,\u0026H0010141E,\u0026H90000000,-1,0,0,0,100,100,0,0,1,5,1,2,72,72,155,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events: list[str] = []
    for beat in beats:
        text = re.sub(r"\s+", " ", str(beat.get("text", "")).strip())
        if not text:
            continue
        text = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
        start = float(beat.get("speech_start", beat.get("start", 0.0)))
        end = float(beat.get("speech_end", beat.get("end", start + 0.2)))
        if end <= start:
            end = start + 0.2
        # ASS line breaks keep phone captions readable without shrinking type.
        tokens = text.split()
        lines: list[str] = []
        line = ""
        for token in tokens:
            candidate = (line + " " + token).strip()
            if len(candidate) > 30 and line:
                lines.append(line)
                line = token
            else:
                line = candidate
        if line:
            lines.append(line)
        caption = "\\N".join(lines[:2])
        events.append(
            f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{caption}"
        )
    output.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
