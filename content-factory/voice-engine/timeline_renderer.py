"""FFmpeg timeline renderer supporting custom scene order, durations, framing, transitions, captions, and audio mix."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any


TRANSITION_MAP = {
    "cut": None,
    "fade": "fade",
    "dissolve": "dissolve",
    "zoom_in": "smoothup",
    "slide_left": "slideleft",
}


def find_font_path() -> str:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return ""


def _escape_drawtext(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
        .replace("\n", " ")
    )


def _wrap_caption(text: str, max_chars: int = 26) -> str:
    words = text.strip().split()
    lines: list[str] = []
    cur: list[str] = []
    for w in words:
        if cur and sum(len(x) for x in cur) + len(cur) + len(w) > max_chars:
            lines.append(" ".join(cur))
            cur = [w]
        else:
            cur.append(w)
    if cur:
        lines.append(" ".join(cur))
    return " / ".join(lines[:3])


def render_timeline_mp4(
    scenes: list[dict[str, Any]],
    voice_audio_path: str,
    output_mp4_path: str,
    audio_mix: dict[str, Any] | None = None,
    music_audio_path: str | None = None,
    width: int = 1080,
    height: int = 1920,
    fps: int = 30,
) -> Path:
    if not scenes:
        raise ValueError("Render edilecek sahne bulunamadı.")

    ordered = sorted(scenes, key=lambda s: int(s.get("order", s.get("scene", 0))))
    font_path = find_font_path()
    mix = audio_mix or {}
    voice_vol = max(0.0, min(2.0, float(mix.get("voiceVolume", 1.0))))
    music_vol = max(0.0, min(1.5, float(mix.get("musicVolume", 0.35))))

    cmd: list[str] = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]

    for item in ordered:
        img_path = str(item["image_path"])
        if not os.path.exists(img_path):
            raise FileNotFoundError(f"Sahne görseli bulunamadı: {img_path}")
        dur = max(0.4, float(item.get("duration", 2.5)))
        cmd.extend(["-loop", "1", "-t", f"{dur:.3f}", "-i", img_path])

    voice_idx = len(ordered)
    cmd.extend(["-i", voice_audio_path])

    has_music = bool(music_audio_path and os.path.exists(music_audio_path))
    music_idx = voice_idx + 1 if has_music else None
    if has_music and music_audio_path:
        cmd.extend(["-stream_loop", "-1", "-i", music_audio_path])

    filter_parts: list[str] = []
    scene_labels: list[str] = []

    for idx, item in enumerate(ordered):
        framing = item.get("framing") or {}
        scale = max(0.8, min(2.5, float(framing.get("scale", 1.0))))
        pan_x = max(-50.0, min(50.0, float(framing.get("panX", 0.0))))
        pan_y = max(-50.0, min(50.0, float(framing.get("panY", 0.0))))

        scaled_w = int(round(width * scale))
        scaled_h = int(round(height * scale))
        if scaled_w % 2:
            scaled_w += 1
        if scaled_h % 2:
            scaled_h += 1

        # Base cover scale + custom crop/pan
        x_offset = max(0, min(scaled_w - width, int(round((scaled_w - width) * (0.5 + pan_x / 100.0)))))
        y_offset = max(0, min(scaled_h - height, int(round((scaled_h - height) * (0.5 + pan_y / 100.0)))))

        chain = (
            f"[{idx}:v]"
            f"scale={scaled_w}:{scaled_h}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height}:{x_offset}:{y_offset},"
            f"fps={fps},format=yuv420p,setsar=1"
        )

        caption_raw = str(item.get("text", "")).strip()
        if caption_raw and font_path:
            escaped = _escape_drawtext(_wrap_caption(caption_raw))
            chain += (
                f",drawtext=fontfile='{font_path}':text='{escaped}':"
                f"fontcolor=white:fontsize=52:box=1:boxcolor=black@0.62:boxborderw=18:"
                f"x=(w-text_w)/2:y=h-320"
            )

        out_label = f"v{idx}"
        chain += f"[{out_label}]"
        filter_parts.append(chain)
        scene_labels.append(out_label)

    # Apply transitions with xfade when multiple scenes exist
    if len(scene_labels) == 1:
        video_out_label = scene_labels[0]
    else:
        cur_label = scene_labels[0]
        cur_offset = max(0.4, float(ordered[0].get("duration", 2.5)))
        xfade_dur = 0.35

        for idx in range(1, len(scene_labels)):
            next_label = scene_labels[idx]
            trans_name = str(ordered[idx].get("transition", "cut"))
            xfade_style = TRANSITION_MAP.get(trans_name)
            next_dur = max(0.4, float(ordered[idx].get("duration", 2.5)))
            out_label = f"xf{idx}"

            if xfade_style and cur_offset > xfade_dur + 0.1 and next_dur > xfade_dur + 0.1:
                offset_val = max(0.1, cur_offset - xfade_dur)
                filter_parts.append(
                    f"[{cur_label}][{next_label}]xfade=transition={xfade_style}:duration={xfade_dur:.2f}:offset={offset_val:.3f}[{out_label}]"
                )
                cur_offset = offset_val + next_dur
            else:
                filter_parts.append(f"[{cur_label}][{next_label}]concat=n=2:v=1:a=0[{out_label}]")
                cur_offset += next_dur

            cur_label = out_label

        video_out_label = cur_label

    # Audio mixing
    if has_music and music_idx is not None:
        filter_parts.append(
            f"[{voice_idx}:a]volume={voice_vol:.2f}[va];"
            f"[{music_idx}:a]volume={music_vol:.2f}[ma];"
            f"[va][ma]amix=inputs=2:duration=first:dropout_transition=2[aout]"
        )
    else:
        filter_parts.append(f"[{voice_idx}:a]volume={voice_vol:.2f}[aout]")

    cmd.extend(["-filter_complex", ";".join(filter_parts)])
    cmd.extend([
        "-map", f"[{video_out_label}]",
        "-map", "[aout]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        output_mp4_path,
    ])

    subprocess.run(cmd, check=True)
    out = Path(output_mp4_path)
    if not out.exists() or out.stat().st_size < 1024:
        raise RuntimeError("MP4 çıktısı oluşturulamadı veya boş.")
    return out
