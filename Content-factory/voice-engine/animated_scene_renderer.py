"""Procedural pixel-art animation renderer for Content Factory's no-stock animation mode.

Produces a vertical 9:16 video with a colorful geometric background, a dark retro
screen containing a topic-matched animated pixel scene, and bold outlined captions.
No stock photos, web images, or external visual assets are used.
"""
from __future__ import annotations

import math
import os
import random
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT, FPS = 540, 960, 15
PALETTE = ["#FF3B30", "#FF2798", "#FFC928", "#20D34B", "#05B8F2", "#FF871B", "#7A35F2", "#00B989"]
INK = "#111027"
PANEL = "#17162F"
PANEL_INNER = "#222044"

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
]

KIND_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    ("minecraft", ("minecraft", "blok", "bloklar", "küp", "kare dünya", "craft", "pixel dünya")),
    ("pacman", ("pac-man", "pacman", "arcade", "atari", "oyun", "video oyun", "oyuncu", "level", "seviye", "piksel")),
    ("cartoon", ("çizgi film", "animasyon", "cartoon", "karakter", "tom ve jerry", "bugs bunny", "simpsons", "sünger bob", "yasaklanan bölüm")),
    ("film", ("film", "sinema", "oyuncu", "aktör", "aktris", "hollywood", "kamera", "sahne", "yönetmen", "dizi", "ünlü")),
    ("space", ("uzay", "gezegen", "mars", "ay'a", "astronot", "nasa", "galaksi", "yıldız", "roket", "evren")),
    ("science", ("bilim", "deney", "laboratuvar", "atom", "kimya", "fizik", "buluş", "icat", "mikroskop", "dna", "gen")),
    ("history", ("tarih", "antik", "roma", "mısır", "firavun", "kral", "kraliçe", "imparator", "savaş", "osmanlı", "orta çağ", "arkeoloji")),
    ("money", ("para", "dolar", "milyon", "milyar", "servet", "zengin", "fiyat", "ekonomi", "banka", "altın", "yatırım", "satış")),
    ("animal", ("köpek", "kedi", "hayvan", "kuş", "aslan", "kaplan", "balina", "köpekbalığı", "at", "fil", "ayı")),
    ("sport", ("futbol", "basketbol", "maç", "gol", "spor", "boks", "yumruk", "şampiyon", "takım", "stadyum", "top")),
    ("computer", ("bilgisayar", "internet", "yazılım", "kod", "şifre", "hacker", "siber", "teknoloji", "yapay zeka", "robot", "uygulama", "telefon")),
    ("city", ("şehir", "istanbul", "paris", "londra", "new york", "bina", "köprü", "metro", "gökdelen", "ülke", "seyahat", "harita")),
    ("music", ("müzik", "şarkı", "şarkıcı", "albüm", "konser", "nota", "gitar", "piyano", "rap", "melodi")),
    ("nature", ("orman", "ağaç", "doğa", "deniz", "okyanus", "dağ", "nehir", "bitki", "çiçek", "iklim", "yangın", "deprem")),
    ("mystery", ("gizem", "sır", "kayıp", "bilinmeyen", "gizli", "anahtar", "kanıt", "teori", "komplo", "esrarengiz")),
]


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        if os.path.isfile(path):
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def infer_kind(text: str, context: str = "") -> str:
    # Prefer the current narration beat; use the project context only when the
    # beat itself contains no recognizable subject clue.
    local_value = str(text or "").casefold()
    for kind, words in KIND_PATTERNS:
        if any(word in local_value for word in words):
            return kind
    context_value = str(context or "").casefold()
    for kind, words in KIND_PATTERNS:
        if any(word in context_value for word in words):
            return kind
    return "mystery"


def caption_lines(text: str, max_chars: int = 20, max_lines: int = 3) -> list[str]:
    words = str(text or "").replace("\n", " ").split()
    if not words:
        return [""]
    lines: list[str] = []
    current = ""
    for word in words:
        if len(current) + len(word) + (1 if current else 0) <= max_chars:
            current = (current + " " + word).strip()
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1].rstrip(".,!?;:") + "…"
    return lines


def _center_text(draw: ImageDraw.ImageDraw, text: str, y: int, font: ImageFont.ImageFont,
                 fill: str = "white", stroke: str = INK, stroke_width: int = 4) -> None:
    box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    x = (WIDTH - (box[2] - box[0])) // 2
    draw.text((x + 2, y + 4), text, font=font, fill=INK, stroke_width=stroke_width + 2, stroke_fill=INK)
    draw.text((x, y), text, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke)


def _draw_geometry(draw: ImageDraw.ImageDraw, color: str, t: float, seed: int) -> None:
    shapes = [
        ("ellipse", (13, 28, 112, 126)), ("triangle", (430, 52, 512, 148)),
        ("rect", (26, 755, 122, 846)), ("triangle", (422, 755, 520, 855)),
        ("ellipse", (449, 365, 535, 451)), ("rect", (11, 388, 74, 452)),
    ]
    for i, (kind, box) in enumerate(shapes):
        offset = int(math.sin(t * 1.1 + i * .8) * 5)
        x1, y1, x2, y2 = box
        box2 = (x1 + offset, y1 + offset, x2 + offset, y2 + offset)
        width = 2 if i % 2 else 1
        if kind == "ellipse":
            draw.ellipse(box2, outline=color, width=width)
        elif kind == "rect":
            draw.rectangle(box2, outline=color, width=width)
        else:
            draw.line([(x1 + offset, y2 + offset), ((x1 + x2)//2 + offset, y1 + offset),
                       (x2 + offset, y2 + offset), (x1 + offset, y2 + offset)], fill=color, width=width)
    draw.line((0, 184, 56, 184), fill=color, width=2)
    draw.line((486, 520, 540, 520), fill=color, width=2)


def _pixel_art(kind: str, t: float, seed: int) -> Image.Image:
    """Render a crisp low-resolution animated motif, scaled nearest-neighbour."""
    w, h = 120, 94
    im = Image.new("RGB", (w, h), PANEL_INNER)
    d = ImageDraw.Draw(im)
    rng = random.Random(seed)
    for i in range(22):
        x = rng.randrange(4, w - 4)
        y = rng.randrange(4, h - 4)
        if (i + int(t * 4)) % 4 == 0:
            d.rectangle((x, y, x + 1, y + 1), fill="#E7E7FF")

    if kind == "pacman":
        d.rectangle((0, 0, w, h), fill="#101027")
        for x in range(10, 115, 12):
            for y in range(10, 88, 12):
                if (x + y) % 3:
                    d.rectangle((x, y, x + 2, y + 2), fill="#FFD46B")
        px = 18 + int((t * 34) % 70)
        cy = 48 + int(math.sin(t * 4) * 4)
        d.pieslice((px - 11, cy - 11, px + 11, cy + 11),
                   30 if int(t * 7) % 2 else 8, 330, fill="#FFE52A")
        gx = 83 - int((t * 20) % 22)
        d.rectangle((gx - 9, 37, gx + 9, 61), fill="#F04459")
        d.rectangle((gx - 9, 32, gx + 9, 47), fill="#F04459")
        d.rectangle((gx - 6, 39, gx - 2, 45), fill="white")
        d.rectangle((gx + 2, 39, gx + 6, 45), fill="white")
        d.rectangle((gx - 5, 41, gx - 3, 45), fill="#19204F")
        d.rectangle((gx + 3, 41, gx + 5, 45), fill="#19204F")
        d.rectangle((7, 7, 21, 9), fill="#31D6EF")
    elif kind == "minecraft":
        d.rectangle((0, 0, w, 60), fill="#78B8F2")
        d.rectangle((0, 60, w, h), fill="#5C9B42")
        d.rectangle((0, 75, w, h), fill="#70482E")
        cloud_x = int((t * 9) % 150) - 25
        d.rectangle((cloud_x, 15, cloud_x + 21, 20), fill="#F4F5FF")
        d.rectangle((cloud_x + 7, 10, cloud_x + 17, 24), fill="#F4F5FF")
        d.rectangle((72, 20, 84, 32), fill="#FFD846")
        for x in (20, 92):
            d.rectangle((x, 44, x + 7, 70), fill="#70452C")
            d.rectangle((x - 10, 31, x + 17, 50), fill="#2F8D45")
            d.rectangle((x - 6, 25, x + 13, 44), fill="#42A94E")
        d.rectangle((0, 72, 120, 76), fill="#91D85A")
        ox, oy = 102, 53
        d.line((ox, oy + 15, ox + int(math.sin(t * 3) * 5), oy - 12), fill="#C48A4D", width=4)
        d.line((ox - 9, oy - 10, ox + 11, oy - 14), fill="#B8DDE2", width=5)
    elif kind == "film":
        d.rectangle((12, 11, 108, 82), fill="#25233D", outline="#F8E94E", width=3)
        d.rectangle((18, 18, 102, 63), fill="#303E71")
        d.ellipse((40, 28, 78, 66), fill="#E85B56")
        d.ellipse((49, 30, 61, 42), fill="#F3B58A")
        d.rectangle((47, 43, 64, 60), fill="#EFC5AA")
        for x in range(18, 105, 14):
            d.rectangle((x, 12, x + 7, 18), fill="#F8E94E")
            d.rectangle((x, 75, x + 7, 81), fill="#F8E94E")
        d.rectangle((79, 43, 91, 55), fill="#EAE9FF")
    elif kind == "cartoon":
        d.rectangle((12, 9, 108, 84), fill="#17152E", outline="#F7E65B", width=3)
        bounce = int(math.sin(t * 5) * 4)
        d.ellipse((39, 21 + bounce, 82, 64 + bounce), fill="#FFD52E", outline="#111027", width=2)
        d.ellipse((49, 32 + bounce, 55, 40 + bounce), fill="white")
        d.ellipse((66, 32 + bounce, 72, 40 + bounce), fill="white")
        d.ellipse((51, 34 + bounce, 54, 39 + bounce), fill=INK)
        d.ellipse((68, 34 + bounce, 71, 39 + bounce), fill=INK)
        d.arc((52, 39 + bounce, 72, 55 + bounce), 0, 180, fill=INK, width=3)
        d.rectangle((30, 68, 90, 73), fill="#F04473")
    elif kind == "space":
        d.rectangle((0, 0, w, h), fill="#12132F")
        for i in range(26):
            x = (i * 37 + 11) % w
            y = (i * 23 + 5) % h
            if (i + int(t * 3)) % 3:
                d.rectangle((x, y, x + 2, y + 2), fill="#F7F0B4")
        d.ellipse((37, 19, 88, 70), fill="#7A50D6", outline="#F4D86A", width=2)
        d.ellipse((50, 28, 65, 42), fill="#B996F3")
        d.ellipse((24, 35, 103, 57), outline="#F2CF69", width=5)
        d.rectangle((83, 67, 105, 80), fill="#E65D52")
        d.polygon([(82, 67), (77, 74), (82, 80)], fill="#F8D65E")
    elif kind == "science":
        d.rectangle((0, 0, w, h), fill="#151A3B")
        cx, cy = 60, 45
        for angle in (0, 60, 120):
            pts = []
            for q in range(25):
                a = math.radians(angle) + q * math.pi / 12
                pts.append((cx + 37 * math.cos(a), cy + 19 * math.sin(a)))
            d.line(pts, fill="#57DCE8", width=3)
        d.ellipse((55, 40, 65, 50), fill="#FFE44F")
        for x, y, c in ((25, 24, "#FF5B72"), (92, 28, "#9E83FF"), (75, 70, "#6BE69A")):
            d.ellipse((x-5, y-5, x+5, y+5), fill=c)
        d.rectangle((8, 77, 112, 82), fill="#E7E7FF")
    elif kind == "history":
        d.rectangle((0, 0, w, h), fill="#332455")
        d.rectangle((12, 65, 108, 82), fill="#A66A3F")
        d.rectangle((28, 35, 92, 68), fill="#C9A05A")
        d.rectangle((20, 26, 36, 69), fill="#DAB66D")
        d.rectangle((84, 26, 100, 69), fill="#DAB66D")
        d.polygon([(16, 27), (28, 12), (40, 27)], fill="#E9C879")
        d.polygon([(80, 27), (92, 12), (104, 27)], fill="#E9C879")
        d.rectangle((51, 48, 69, 68), fill="#4F386A")
        d.rectangle((56, 54, 64, 68), fill="#E6D19B")
        d.rectangle((5, 83, 115, 88), fill="#E7C778")
    elif kind == "money":
        d.rectangle((0, 0, w, h), fill="#153C3B")
        bob = int(math.sin(t * 4) * 3)
        d.rounded_rectangle((24, 23 + bob, 96, 70 + bob), radius=5, fill="#2FBF78", outline="#C4F46A", width=3)
        d.ellipse((48, 30 + bob, 72, 62 + bob), fill="#D9F46A", outline="#153C3B", width=2)
        d.text((55, 35 + bob), "$", fill="#153C3B")
        for x, y in ((15, 72), (90, 12), (98, 76)):
            d.ellipse((x-7, y-7, x+7, y+7), fill="#F9D44D", outline="#B17B25", width=2)
    elif kind == "animal":
        d.rectangle((0, 0, w, h), fill="#345A62")
        bounce = int(math.sin(t * 5) * 3)
        d.ellipse((35, 27 + bounce, 86, 76 + bounce), fill="#D69B62", outline="#F8D6A2", width=2)
        d.polygon([(39, 38+bounce), (34, 12+bounce), (54, 27+bounce)], fill="#D69B62")
        d.polygon([(67, 27+bounce), (88, 12+bounce), (81, 42+bounce)], fill="#D69B62")
        d.ellipse((49, 43+bounce, 55, 49+bounce), fill=INK)
        d.ellipse((68, 43+bounce, 74, 49+bounce), fill=INK)
        d.ellipse((58, 54+bounce, 66, 60+bounce), fill="#56313C")
    elif kind == "sport":
        d.rectangle((0, 0, w, h), fill="#1B3B50")
        bx = 58 + int(math.sin(t * 4) * 19)
        by = 47 + int(abs(math.sin(t * 4)) * -8)
        d.ellipse((bx-20, by-20, bx+20, by+20), fill="#F2F2E8", outline="#101027", width=3)
        d.polygon([(bx,by-7),(bx+8,by-1),(bx+5,by+9),(bx-5,by+9),(bx-8,by-1)], fill="#202039")
        d.line((bx-20,by-5,bx-7,by-10),fill="#202039",width=3)
        d.line((bx+7,by-10,bx+20,by-5),fill="#202039",width=3)
    elif kind == "computer":
        d.rectangle((0, 0, w, h), fill="#10152C")
        d.rounded_rectangle((13, 10, 107, 69), radius=5, fill="#050A18", outline="#7CE8F1", width=3)
        for i in range(6):
            height = 12 + int((math.sin(t*4+i*.9)+1)*15)
            x = 22 + i*14
            d.rectangle((x, 60-height, x+7, 60), fill=("#46E5F1" if i%2==0 else "#F7E44E"))
        d.rectangle((49, 70, 72, 77), fill="#AAB9D7")
        d.rectangle((37, 78, 84, 83), fill="#D7D9E7")
    elif kind == "city":
        d.rectangle((0, 0, w, h), fill="#263B72")
        d.rectangle((0, 72, w, h), fill="#20223C")
        for x, top, color in ((8,35,"#F3A85A"),(34,20,"#63C7D9"),(62,42,"#D77C5E"),(90,26,"#88C5A2")):
            d.rectangle((x, top, x+20, 82), fill=color)
            for yy in range(top+8,76,12):
                for xx in range(x+5,x+18,8):
                    d.rectangle((xx,yy,xx+3,yy+4),fill="#FFF0A4")
        d.rectangle((0, 82, 120, 88), fill="#F4CF64")
    elif kind == "music":
        d.rectangle((0, 0, w, h), fill="#33214D")
        for i in range(5):
            x = 20 + i*20
            bar = 22 + int((math.sin(t*5+i)*.5+.5)*43)
            d.rounded_rectangle((x,78-bar,x+9,78),radius=3,fill=("#50D8E6" if i%2 else "#FFCA45"))
        d.ellipse((79,12,108,41),fill="#FF6590")
        d.polygon([(95,15),(95,56),(89,52),(89,25)],fill="#FF6590")
    elif kind == "nature":
        d.rectangle((0, 0, w, h), fill="#76BFE2")
        d.rectangle((0, 66, w, h), fill="#4D994E")
        d.ellipse((82, 8, 107, 33), fill="#FFE05C")
        d.rectangle((54, 40, 66, 81), fill="#855332")
        d.ellipse((30, 17, 91, 62), fill="#2C9A53")
        d.ellipse((41, 8, 81, 50), fill="#46B966")
        d.rectangle((0, 82, 120, 94), fill="#6E4B2D")
    else:
        d.rectangle((0, 0, w, h), fill="#181432")
        d.rounded_rectangle((24, 14, 96, 82), radius=7, fill="#3D2B73", outline="#F2D64E", width=3)
        d.text((47, 15), "?", font=ImageFont.load_default(), fill="#FFE341")
        d.ellipse((48, 63, 72, 86), fill="#FFE341")
        d.rectangle((58, 25, 63, 59), fill="#FFE341")
        d.rectangle((58, 68, 63, 73), fill="#17152F")

    return im.resize((248, 194), Image.Resampling.NEAREST)


def _draw_window(canvas: Image.Image, kind: str, t: float, seed: int) -> None:
    draw = ImageDraw.Draw(canvas)
    x1, y1, x2, y2 = 118, 196, 422, 480
    draw.rounded_rectangle((x1 + 7, y1 + 10, x2 + 7, y2 + 10), radius=22, fill="#171322")
    draw.rounded_rectangle((x1, y1, x2, y2), radius=22, fill=INK, outline="#070716", width=5)
    draw.rounded_rectangle((x1 + 10, y1 + 10, x2 - 10, y2 - 10), radius=15, fill=PANEL)
    for i, color in enumerate(("#FF5D6C", "#FFD54D", "#58E39D")):
        draw.ellipse((x1 + 19 + i * 15, y1 + 18, x1 + 28 + i * 15, y1 + 27), fill=color)
    art = _pixel_art(kind, t, seed)
    canvas.paste(art, ((WIDTH - art.width) // 2, y1 + 45))
    draw = ImageDraw.Draw(canvas)
    draw.line((x1 + 19, y2 - 18, x2 - 19, y2 - 18), fill="#383653", width=2)
    for i in range(7):
        w = 18 if i < 3 else 8
        draw.rounded_rectangle((x1 + 22 + i * 34, y2 - 12, x1 + 22 + i * 34 + w, y2 - 8), radius=2,
                               fill=("#FFE34A" if (i + int(t * 4)) % 3 == 0 else "#4B486B"))


def render_frame(scene: dict[str, Any], frame_in_scene: int, scene_frame_count: int,
                 global_index: int, context: str = "") -> Image.Image:
    seed = int(scene.get("index", global_index + 1)) * 137
    kind = str(scene.get("visual_kind") or infer_kind(str(scene.get("text", "")), context))
    palette_index = (int(scene.get("index", global_index + 1)) - 1) % len(PALETTE)
    bg = PALETTE[palette_index]
    accent = "#1A1630" if palette_index in (1, 2, 4, 5, 6) else "#FFF2D0"
    local_t = frame_in_scene / max(1, FPS)
    phase = frame_in_scene / max(1, scene_frame_count)

    canvas = Image.new("RGB", (WIDTH, HEIGHT), bg)
    draw = ImageDraw.Draw(canvas)
    _draw_geometry(draw, accent, local_t, seed)
    dash_x = 210 + int(math.sin(local_t * 3) * 14)
    draw.rounded_rectangle((dash_x, 502, dash_x + 120, 510), radius=4, fill=accent)
    _draw_window(canvas, kind, local_t, seed)

    lines = caption_lines(str(scene.get("text", "")), max_chars=20, max_lines=3)
    font_size = 37 if len(lines) <= 2 else 33
    font = _font(font_size)
    line_height = 47 if font_size == 37 else 41
    total_h = len(lines) * line_height
    top = 624 + max(0, (155 - total_h) // 2)
    d = ImageDraw.Draw(canvas)
    for i, line in enumerate(lines):
        _center_text(d, line.upper(), top + i * line_height, font, stroke_width=4)
    sparkle_x = 85 + int((phase * 210) % 260)
    sparkle_y = 566 + int(math.sin(local_t * 3) * 5)
    d.ellipse((sparkle_x, sparkle_y, sparkle_x + 5, sparkle_y + 5), fill="#FFF4B4")
    return canvas


def render_animated_video(scenes: list[dict[str, Any]], voice_audio_path: str,
                          output_mp4_path: str, duration: float,
                          context: str = "", width: int = 1080, height: int = 1920,
                          fps: int = FPS) -> Path:
    if not scenes:
        raise ValueError("Animasyon için sahne bulunamadı.")
    if not Path(voice_audio_path).is_file():
        raise FileNotFoundError("Animasyonun ses dosyası bulunamadı.")
    if duration <= 0:
        raise ValueError("Animasyon süresi geçersiz.")
    total_frames = max(1, int(round(duration * fps)))
    durations = [max(0.08, float(s.get("duration", 0.5))) for s in scenes]
    total_scene_duration = sum(durations)
    if total_scene_duration <= 0:
        raise ValueError("Animasyon sahne süreleri geçersiz.")
    if abs(total_scene_duration - duration) > 0.05:
        factor = duration / total_scene_duration
        durations = [x * factor for x in durations]
    frame_counts = [max(1, int(round(x * fps))) for x in durations]
    drift = total_frames - sum(frame_counts)
    frame_counts[-1] = max(1, frame_counts[-1] + drift)

    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-video_size", f"{WIDTH}x{HEIGHT}",
        "-framerate", str(fps), "-i", "pipe:0", "-i", str(voice_audio_path),
        "-map", "0:v:0", "-map", "1:a:0?", "-vf", f"scale={width}:{height}:flags=neighbor,fps=30,setsar=1",
        "-t", f"{duration:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest",
        "-movflags", "+faststart", output_mp4_path,
    ]
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        global_index = 0
        for scene, count in zip(scenes, frame_counts):
            for local_index in range(count):
                frame = render_frame(scene, local_index, count, global_index, context)
                assert proc.stdin is not None
                proc.stdin.write(frame.tobytes())
                global_index += 1
        if proc.stdin:
            proc.stdin.close()
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        code = proc.wait(timeout=max(120, int(duration * 8)))
        if code != 0:
            raise RuntimeError("FFmpeg animasyon render hatası: " + stderr[-1200:])
    except Exception:
        proc.kill()
        proc.wait()
        raise
    out = Path(output_mp4_path)
    if not out.is_file() or out.stat().st_size < 2048:
        raise RuntimeError("Animasyon MP4 dosyası oluşturulamadı veya boş.")
    return out
