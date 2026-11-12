from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
import requests
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, ImageDraw, ImageFont

APP_DIR = Path(__file__).resolve().parent
TTS_INTERNAL_URL = os.getenv("TTS_INTERNAL_URL", "http://127.0.0.1:18083").rstrip("/")
API_TOKEN = os.getenv("FACTORY_API_TOKEN", "")
ASR_MODEL = os.getenv("ASR_MODEL_SIZE", "base")
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(30 * 1024 * 1024)))
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "7200"))
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "ContentFactory/1.0 (Short-form video creator; license-aware media search)"
PALETTE = ["#FFE600", "#FF2694", "#00BFF3", "#FF6A00", "#B8F500", "#762BFF", "#FF3D27", "#00B989", "#165CFF", "#F500A3"]
STOP_WORDS = set("""ve veya ama fakat çünkü gibi için ile bir bu şu o da de ki ne mi mı mu mü daha çok az her bazı nasıl neden niçin zaman zamanında olan olanlar olarak sonra önce kadar göre ise hem ya yani diye kadar tüm bütün çok şey yeni eski ilk son birisi insan insanlar oyun oyunlar video bugün gerçekten aslında""".split())

app = FastAPI(title="Content Factory Voice & Video Engine", version="0.2.0")
origins = [x.strip() for x in os.getenv("ALLOWED_ORIGINS", "https://content-factory-7s6.pages.dev,http://localhost:8788,http://127.0.0.1:8788").split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Factory-Token"],
)

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cf-render")


def require_access(x_factory_token: str | None = Header(default=None)) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="Motor yöneticisi FACTORY_API_TOKEN ayarlamamış. Servis yöneticisine başvur.")
    if x_factory_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Geçersiz Content Factory erişim anahtarı.")


def run_command(args: list[str], timeout: int = 900) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)


def probe_duration(path: Path) -> float:
    result = run_command([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ], timeout=30)
    if result.returncode != 0:
        raise RuntimeError("Ses/video süresi okunamadı: " + result.stderr[-500:])
    return float(result.stdout.strip())


def update_job(job_id: str, **values: Any) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(values)
            JOBS[job_id]["updated_at"] = time.time()


@app.get("/health")
async def health() -> dict[str, Any]:
    tts_status = "unknown"
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            response = await client.get(TTS_INTERNAL_URL + "/api/warmup-status")
            tts_status = "ready" if response.is_success else "starting"
    except Exception:
        tts_status = "starting"
    return {
        "ok": True,
        "service": "content-factory-voice-engine",
        "tts_status": tts_status,
        "tts_url": TTS_INTERNAL_URL,
        "asr_model": ASR_MODEL,
        "video_renderer": shutil.which("ffmpeg") is not None,
    }


@app.post("/api/voice/preview")
async def voice_preview(
    text: str = Form(...),
    prompt_audio: UploadFile = File(...),
    _auth: None = Depends(require_access),
) -> Response:
    normalized = (text or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Seslendirme metni boş olamaz.")
    if len(normalized) > 5000:
        raise HTTPException(status_code=413, detail="Tek Shorts metni en fazla 5.000 karakter olabilir.")
    ref_bytes = await prompt_audio.read()
    if not ref_bytes or len(ref_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Referans ses dosyası boş veya izin verilen boyuttan büyük.")
    files = {"prompt_audio": (prompt_audio.filename or "voice-reference.wav", ref_bytes, prompt_audio.content_type or "audio/wav")}
    form = {
        "text": normalized,
        "enable_text_normalization": "0",
        "enable_normalize_tts_text": "1",
        "cpu_threads": os.getenv("CPU_THREADS", "2"),
        "do_sample": "1",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=20)) as client:
            upstream = await client.post(TTS_INTERNAL_URL + "/api/generate", data=form, files=files)
        if not upstream.is_success:
            detail = upstream.text[:1200]
            raise HTTPException(status_code=502, detail="MOSS motoru ses üretemedi: " + detail)
        payload = upstream.json()
        audio_base64 = payload.get("audio_base64")
        if not audio_base64:
            raise HTTPException(status_code=502, detail="MOSS motoru ses dosyası döndürmedi.")
        import base64
        audio_bytes = base64.b64decode(audio_base64)
        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "X-Audio-Sample-Rate": str(payload.get("sample_rate", 48000)),
                "X-Voice-Engine": "MOSS-TTS-Nano-ONNX",
                "Cache-Control": "no-store",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Ses motoruna bağlanılamadı: " + str(exc))


@app.post("/api/shorts/render", status_code=202)
async def start_short_render(
    text: str = Form(...),
    title: str = Form("Shorts"),
    audio: UploadFile = File(...),
    _auth: None = __import__("fastapi").Depends(require_access),
) -> dict[str, Any]:
    script = (text or "").strip()
    audio_bytes = await audio.read()
    if not script or not audio_bytes:
        raise HTTPException(status_code=400, detail="Metin ve onaylanmış ses dosyası gereklidir.")
    if len(script) > 5000 or len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Metin veya ses dosyası izin verilen boyutu aşıyor.")
    cleanup_old_jobs()
    job_id = uuid.uuid4().hex
    work_dir = Path(tempfile.mkdtemp(prefix="cf-" + job_id[:8] + "-"))
    suffix = Path(audio.filename or "").suffix.lower()
    allowed_audio_suffixes = {".mp3", ".m4a", ".wav", ".aac", ".mp4", ".mpeg", ".mpga", ".ogg", ".opus", ".webm", ".flac"}
    if suffix not in allowed_audio_suffixes:
        suffix = {
            "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
            "audio/mp4": ".m4a", "video/mp4": ".m4a",
            "audio/x-m4a": ".m4a", "audio/wav": ".wav",
            "audio/x-wav": ".wav", "audio/aac": ".aac",
            "audio/ogg": ".ogg", "audio/webm": ".webm",
            "audio/flac": ".flac"
        }.get((audio.content_type or "").lower(), ".audio")
    source_audio_name = "approved-preview" + suffix
    source_audio = work_dir / source_audio_name
    source_audio.write_bytes(audio_bytes)
    now = time.time()
    with JOBS_LOCK:
        JOBS[job_id] = {
            "job_id": job_id, "status": "queued", "progress": 1,
            "message": "İş kuyruğa alındı.", "created_at": now,
            "updated_at": now, "directory": str(work_dir), "source_audio": source_audio_name,
            "title": title[:120], "text": script, "error": None,
        }
    POOL.submit(render_short_job, job_id)
    return {"job_id": job_id, "status": "queued", "message": "Ses ve görsel kurgu işlemi kuyruğa alındı."}


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str, _auth: None = __import__("fastapi").Depends(require_access)) -> dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="İş bulunamadı veya geçici dosyalar temizlendi.")
        return {k: v for k, v in job.items() if k not in {"directory", "text"}}


def get_job_file(job_id: str, filename: str, media_type: str, download_name: str) -> FileResponse:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job or job.get("status") != "completed":
            raise HTTPException(status_code=404, detail="Hazır dosya bulunamadı.")
        path = Path(job["directory"]) / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Dosya artık mevcut değil.")
    return FileResponse(str(path), media_type=media_type, filename=download_name)


@app.get("/api/jobs/{job_id}/video")
async def job_video(job_id: str, _auth: None = __import__("fastapi").Depends(require_access)):
    return get_job_file(job_id, "shorts.mp4", "video/mp4", "content-factory-shorts.mp4")


@app.get("/api/jobs/{job_id}/audio")
async def job_audio(job_id: str, _auth: None = __import__("fastapi").Depends(require_access)):
    return get_job_file(job_id, "cleaned.wav", "audio/wav", "shorts-cleaned-voice.wav")


@app.get("/api/jobs/{job_id}/credits")
async def job_credits(job_id: str, _auth: None = __import__("fastapi").Depends(require_access)):
    return get_job_file(job_id, "sources-and-licenses.txt", "text/plain; charset=utf-8", "sources-and-licenses.txt")


def trim_silence(source: Path, output: Path) -> float:
    # Short pauses under 550 ms remain; 120 ms of room remains around longer pauses.
    filt = (
        "silenceremove=start_periods=1:start_duration=0.55:start_threshold=-45dB:"
        "stop_periods=-1:stop_duration=0.55:stop_threshold=-45dB:stop_silence=0.12"
    )
    result = run_command([
        "ffmpeg", "-y", "-i", str(source), "-af", filt,
        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(output)
    ], timeout=180)
    if result.returncode != 0 or not output.exists() or output.stat().st_size < 1024:
        shutil.copy2(source, output)
    return max(0.0, probe_duration(source) - probe_duration(output))


def transcribe_audio(audio_path: Path) -> list[dict[str, Any]]:
    from faster_whisper import WhisperModel
    model = WhisperModel(ASR_MODEL, device="cpu", compute_type="int8", cpu_threads=max(1, int(os.getenv("CPU_THREADS", "2"))))
    segments, _info = model.transcribe(str(audio_path), language="tr", beam_size=1, vad_filter=True, word_timestamps=False)
    rows = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text and float(seg.end) > float(seg.start):
            rows.append({"start": float(seg.start), "end": float(seg.end), "text": text})
    return rows


def fallback_segments(text: str, duration: float) -> list[dict[str, Any]]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text) if p.strip()]
    if not parts:
        parts = [text]
    weights = [max(1, len(p.split())) for p in parts]
    total = sum(weights)
    cursor = 0.0
    rows = []
    for part, weight in zip(parts, weights):
        span = duration * weight / total
        rows.append({"start": cursor, "end": min(duration, cursor + span), "text": part})
        cursor += span
    if rows:
        rows[-1]["end"] = duration
    return rows


def make_scene_groups(rows: list[dict[str, Any]], duration: float, target_seconds: float | None = None) -> list[dict[str, Any]]:
    """Create one visual beat per transcript sentence/utterance; no fixed scene-count or seconds cap."""
    groups: list[dict[str, Any]] = []
    for row in rows:
        text = re.sub(r"\s+", " ", str(row.get("text", "")).strip())
        start = max(0.0, float(row.get("start", 0.0)))
        end = min(duration, max(start + 0.05, float(row.get("end", start + 0.5))))
        if not text:
            continue
        parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
        if not parts:
            parts = [text]
        weights = [max(1, len(part.split())) for part in parts]
        total = sum(weights)
        cursor = start
        span = max(0.05, end - start)
        for index, (part, weight) in enumerate(zip(parts, weights)):
            part_end = end if index == len(parts) - 1 else cursor + span * weight / total
            groups.append({"start": cursor, "end": part_end, "text": part})
            cursor = part_end
    if not groups:
        return fallback_segments("", duration)
    groups[0]["start"] = 0.0
    groups[-1]["end"] = duration
    for index, group in enumerate(groups):
        group["start"] = max(0.0, min(duration, float(group["start"])))
        group["end"] = max(group["start"] + 0.05, min(duration, float(group["end"])))
        if index:
            group["start"] = max(group["start"], groups[index - 1]["end"] - 0.04)
    return groups


def plain_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))).strip()


def license_allowed(label: str) -> bool:
    value = (label or "").strip().lower().replace("_", "-")
    if any(x in value for x in ("noncommercial", "non-commercial", "by-nc", "cc-by-nc", "no derivatives", "no-derivatives", "by-nd", "cc-by-nd")):
        return False
    return value in {"cc0", "cc-zero", "pdm", "public domain", "public-domain", "by", "by-sa", "cc-by", "cc-by-sa"} or any(
        x in value for x in ("cc0", "public domain", "public-domain", "cc by", "cc-by", "creative commons attribution")
    )


def search_commons(query: str, limit: int = 20) -> list[dict[str, str]]:
    params = {
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": query, "gsrnamespace": "6", "gsrlimit": str(min(50, limit)),
        "prop": "imageinfo", "iiprop": "url|extmetadata", "iiurlwidth": "1400",
    }
    try:
        response = requests.get(COMMONS_API, params=params, headers={"User-Agent": USER_AGENT}, timeout=25)
        response.raise_for_status()
        data = response.json().get("query", {}).get("pages", {})
    except Exception:
        return []
    items = []
    for page in data.values():
        infos = page.get("imageinfo") or []
        if not infos:
            continue
        info = infos[0]
        mime = str(info.get("mime", ""))
        if not mime.startswith("image/") or mime in {"image/svg+xml", "image/gif"}:
            continue
        meta = info.get("extmetadata") or {}
        license_name = plain_text((meta.get("LicenseShortName") or {}).get("value"))
        if not license_allowed(license_name):
            continue
        url = info.get("thumburl") or info.get("url")
        if not url:
            continue
        items.append({
            "title": plain_text(page.get("title")),
            "url": str(url),
            "page_url": "https://commons.wikimedia.org/wiki/" + str(page.get("title", "")).replace(" ", "_"),
            "author": plain_text((meta.get("Artist") or {}).get("value")),
            "license": license_name,
            "license_url": plain_text((meta.get("LicenseUrl") or {}).get("value")),
            "credit": plain_text((meta.get("Credit") or {}).get("value")),
            "mime": mime,
            "source": "Wikimedia Commons",
        })
    return items


def search_openverse(query: str, limit: int = 20) -> list[dict[str, str]]:
    params = {"q": query, "page_size": str(min(30, limit)), "license": "cc0,pdm,by,by-sa"}
    try:
        response = requests.get(
            "https://api.openverse.org/v1/images/",
            params=params,
            headers={"User-Agent": USER_AGENT},
            timeout=25,
        )
        response.raise_for_status()
        results = response.json().get("results", [])
    except Exception:
        return []
    items = []
    for item in results:
        license_name = str(item.get("license") or "").lower()
        if not license_allowed(license_name):
            continue
        image_url = item.get("thumbnail") or item.get("url")
        page_url = item.get("foreign_landing_url") or item.get("detail_url")
        if not image_url or not page_url:
            continue
        if int(item.get("width") or 0) < 500 or int(item.get("height") or 0) < 400:
            continue
        items.append({
            "title": plain_text(item.get("title") or "Openverse image"),
            "url": str(image_url),
            "page_url": str(page_url),
            "author": plain_text(item.get("creator") or "Not specified"),
            "license": license_name.upper(),
            "license_url": str(item.get("license_url") or ""),
            "credit": "",
            "mime": "image/unknown",
            "source": "Openverse / " + str(item.get("source") or "open collection"),
        })
    return items


def search_library_of_congress(query: str, limit: int = 20) -> list[dict[str, str]]:
    try:
        response = requests.get(
            "https://www.loc.gov/search/",
            params={"fo": "json", "q": query, "c": str(min(30, limit)), "sp": "1"},
            headers={"User-Agent": USER_AGENT},
            timeout=25,
        )
        response.raise_for_status()
        results = response.json().get("results", [])
    except Exception:
        return []
    items = []
    for item in results:
        rights = item.get("rights") or ""
        if isinstance(rights, list):
            rights = " ".join(str(x) for x in rights)
        rights_text = plain_text(rights)
        if not re.search(r"public domain|no known restrictions|no known copyright restrictions|unrestricted", rights_text, re.I):
            continue
        image_urls = item.get("image_url") or []
        if isinstance(image_urls, str):
            image_urls = [image_urls]
        image_url = next((u for u in image_urls if re.search(r"\.(jpe?g|png|webp)(?:$|\?)", str(u), re.I)), None)
        if not image_url:
            continue
        items.append({
            "title": plain_text(item.get("title") or "Library of Congress image"),
            "url": str(image_url),
            "page_url": str(item.get("id") or item.get("url") or ""),
            "author": plain_text(item.get("contributor") or "Library of Congress"),
            "license": "Public domain / no known restrictions",
            "license_url": "https://www.loc.gov/legal/",
            "credit": "",
            "mime": "image/unknown",
            "source": "Library of Congress",
        })
    return items


def search_public_assets(query: str, limit: int = 30) -> list[dict[str, str]]:
    """Search multiple public no-key catalogs; never assume every indexed image is reusable."""
    results = []
    seen = set()
    providers = (search_commons, search_openverse, search_library_of_congress)
    per_provider = max(5, min(20, limit // len(providers)))
    for provider in providers:
        for item in provider(query, limit=per_provider):
            url = item.get("url", "")
            if url and url not in seen:
                seen.add(url)
                results.append(item)
                if len(results) >= limit:
                    return results
    return results


def extract_keywords(text: str) -> str:
    words = re.findall(r"[A-Za-zÇĞİÖŞÜçğıöşü0-9]+", (text or "").lower())
    selected = []
    for word in words:
        if len(word) > 3 and word not in STOP_WORDS and word not in selected:
            selected.append(word)
        if len(selected) >= 6:
            break
    return " ".join(selected) or (text or "")[:80]


def download_commons_asset(item: dict[str, str], directory: Path, index: int) -> Path | None:
    try:
        response = requests.get(item["url"], headers={"User-Agent": USER_AGENT}, timeout=30, stream=True)
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "")
        if not content_type.startswith("image/"):
            return None
        content = bytearray()
        for chunk in response.iter_content(1024 * 128):
            if chunk:
                content.extend(chunk)
                if len(content) > 18 * 1024 * 1024:
                    return None
        path = directory / ("commons-" + str(index) + ".img")
        path.write_bytes(content)
        with Image.open(path) as image:
            image.verify()
        return path
    except Exception:
        return None


def load_font(size: int, bold: bool = True):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def cover_image(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_w, target_h = size
    source = image.convert("RGB")
    scale = max(target_w / source.width, target_h / source.height)
    resized = source.resize((int(source.width * scale), int(source.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - target_w) // 2
    top = (resized.height - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def wrap_lines(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = (text or "").split()
    lines: list[str] = []
    line = ""
    for word in words:
        candidate = (line + " " + word).strip()
        if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width or not line:
            line = candidate
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def draw_rounded_compat(draw: ImageDraw.ImageDraw, xy, radius: int = 24, **kwargs) -> None:
    """Pillow compatibility: use rounded corners when available, safe rectangle fallback otherwise."""
    method = getattr(draw, "rounded_rectangle", None)
    if callable(method):
        method(xy, radius=radius, **kwargs)
    else:
        draw.rectangle(xy, **kwargs)


def draw_wrapped(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, x: int, y: int, max_width: int, fill: str, max_lines: int = 4) -> int:
    lines = wrap_lines(draw, text, font, max_width)[:max_lines]
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill, stroke_width=2, stroke_fill="#161616")
        y += int(font.size * 1.18)
    return y


def create_visual_canvas(group: dict[str, Any], assets: list[tuple[Path, dict[str, str]]], index: int, output: Path, title: str, hook: str = "") -> None:
    width, height = 1080, 1920
    color = PALETTE[index % len(PALETTE)]
    text = (group.get("text") or title or "Bilinmeyen gerçekler").strip()
    bg_asset = None
    second_asset = None
    if assets:
        try:
            bg_asset = Image.open(assets[0][0]).convert("RGB")
        except Exception:
            bg_asset = None
    if len(assets) > 1:
        try:
            second_asset = Image.open(assets[1][0]).convert("RGB")
        except Exception:
            second_asset = None
    canvas = Image.new("RGB", (width, height), color)
    draw = ImageDraw.Draw(canvas)
    is_numeric = bool(re.search(r"\d", text))
    is_compare = any(k in text.lower() for k in (" karşı ", " versus ", " ile ", " fark ", " önce ", " sonra ", " vs "))
    layout = "infographic" if is_numeric else ("split" if is_compare or index % 4 == 1 else ("collage" if second_asset is not None and index % 3 == 0 else "full"))
    title_font = load_font(78)
    small_font = load_font(30)
    if layout == "full" and bg_asset is not None:
        photo = cover_image(bg_asset, (width, height))
        canvas.paste(photo)
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.rectangle((0, 0, width, 245), fill=(10, 12, 20, 185))
        od.rectangle((0, 1390, width, height), fill=(10, 12, 20, 205))
        canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(canvas)
        draw_rounded_compat(draw,(55, 60, 520, 155), radius=35, fill=color)
        draw.text((90, 79), "BİLİNMEYEN GERÇEK", font=small_font, fill="#141414")
        draw_wrapped(draw, text, title_font, 58, 1480, 960, "white", 4)
    elif layout == "split" and bg_asset is not None:
        photo = cover_image(bg_asset, (650, height))
        canvas.paste(photo, (0, 0))
        draw.rectangle((650, 0, width, height), fill=color)
        draw.rectangle((0, 0, 650, 180), fill="#12141D")
        draw.text((44, 60), "GERÇEK / DETAY", font=small_font, fill="white")
        draw_wrapped(draw, text, load_font(58), 690, 580, 340, "#121212", 7)
        draw_rounded_compat(draw,(690, 1510, 1030, 1800), radius=45, fill="#12141D")
        draw.text((730, 1580), "DEVAMINI", font=load_font(38), fill="white")
        draw.text((730, 1640), "KEŞFET", font=load_font(54), fill=color)
    elif layout == "collage":
        draw.rectangle((0, 0, width, height), fill=color)
        if bg_asset is not None:
            canvas.paste(cover_image(bg_asset, (width - 100, 760)), (50, 70))
        if second_asset is not None:
            canvas.paste(cover_image(second_asset, (470, 530)), (70, 910))
        draw_rounded_compat(draw,(565, 930, 1010, 1460), radius=34, fill="#171923")
        draw_wrapped(draw, text, load_font(46), 605, 1010, 360, "white", 6)
        draw.text((60, 1630), "BİR DETAY HER ŞEYİ DEĞİŞTİRİR", font=load_font(34), fill="#171923")
    else:
        draw.rectangle((0, 0, width, height), fill=color)
        if bg_asset is not None:
            photo = cover_image(bg_asset, (780, 700))
            canvas.paste(photo, (150, 170))
            draw_rounded_compat(draw,(120, 130, 960, 940), radius=34, outline="#151515", width=14)
        draw.ellipse((770, 1000, 1030, 1260), fill="#FF9C69", outline="#151515", width=8)
        draw.text((835, 1075), "!", font=load_font(130), fill="#151515")
        draw_wrapped(draw, text, load_font(76), 65, 1320, 950, "#151515", 5)
        draw_rounded_compat(draw,(60, 1770, 700, 1870), radius=35, fill="#151515")
        draw.text((100, 1797), "BİLGİ · MERAK · KEŞİF", font=small_font, fill="white")
    if hook:
        banner = PALETTE[(index + 2) % len(PALETTE)]
        draw = ImageDraw.Draw(canvas)
        draw.rectangle((0, 0, width, 145), fill=banner)
        draw_wrapped(draw, hook, load_font(54), 48, 28, 980, "#101018", 2)
    canvas.save(output, quality=92)


def render_one_scene(canvas: Path, duration: float, output: Path) -> None:
    frames = max(25, int(round(duration * 25)))
    zoom = "zoompan=z='min(zoom+0.00065,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=25"
    result = run_command([
        "ffmpeg", "-y", "-loop", "1", "-i", str(canvas), "-t", str(max(0.6, duration)),
        "-vf", zoom + ",format=yuv420p", "-r", "25", "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", str(output)
    ], timeout=240)
    if result.returncode != 0 or not output.exists():
        raise RuntimeError("Sahne render edilemedi: " + result.stderr[-900:])


def render_short_job(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        work_dir = Path(job["directory"])
        script = job["text"]
        title = job["title"]
        hook = job.get("hook", "")
    try:
        update_job(job_id, status="running", progress=8, message="Onaylanan sesin uzun sessizlikleri temizleniyor…")
        source_audio = work_dir / job.get("source_audio", "approved-preview.wav")
        cleaned_audio = work_dir / "cleaned.wav"
        removed = trim_silence(source_audio, cleaned_audio)
        duration = probe_duration(cleaned_audio)
        if duration < 8:
            raise RuntimeError("Ses çok kısa. Lütfen daha uzun bir seslendirme üret.")
        update_job(job_id, progress=22, message="Türkçe konuşma zaman kodları çıkarılıyor…")
        try:
            rows = transcribe_audio(cleaned_audio)
        except Exception as exc:
            rows = fallback_segments(script, duration)
            update_job(job_id, progress=30, message="Konuşma zaman kodu yedeği kullanılıyor: " + str(exc)[:160])
        groups = make_scene_groups(rows, duration)
        if not groups:
            groups = fallback_segments(script, duration)
        update_job(job_id, progress=38, message="Wikimedia Commons stok görselleri lisanslarıyla aranıyor…")
        source_records: list[dict[str, str]] = []
        scene_assets: list[list[tuple[Path, dict[str, str]]]] = []
        user_images: list[Path] = []
        for name in job.get("user_images", []):
            path = work_dir / Path(name).name
            if path.is_file():
                try:
                    with Image.open(path) as image:
                        image.verify()
                    user_images.append(path)
                except Exception:
                    pass
        for idx, group in enumerate(groups):
            query = extract_keywords(group["text"])
            candidates = search_public_assets(query, limit=30)
            chosen: list[tuple[Path, dict[str, str]]] = []
            for candidate in candidates:
                asset_path = download_commons_asset(candidate, work_dir, len(source_records) + 1)
                if asset_path:
                    chosen.append((asset_path, candidate))
                    source_records.append(candidate)
                    break
            if not chosen and user_images:
                own_path = user_images[idx % len(user_images)]
                chosen.append((own_path, {"title": own_path.name, "author": "User supplied", "license": "User supplied; verify your own rights", "license_url": "", "page_url": "", "source": "User upload"}))
                source_records.append(chosen[0][1])
            scene_assets.append(chosen)
            progress = 38 + int(28 * (idx + 1) / max(1, len(groups)))
            update_job(job_id, progress=progress, message="Görseller ve lisanslar seçiliyor… (" + str(idx + 1) + "/" + str(len(groups)) + ")")
        update_job(job_id, progress=70, message="Canlı renkli kolaj, infografik ve sahne animasyonları oluşturuluyor…")
        clips = []
        total_duration = sum(max(0.7, float(g["end"]) - float(g["start"])) for g in groups)
        cursor = 0.0
        for idx, group in enumerate(groups):
            start = cursor
            scene_duration = max(0.7, float(group["end"]) - float(group["start"]))
            if idx == len(groups) - 1:
                scene_duration = max(0.7, duration - cursor)
            cursor += scene_duration
            canvas_path = work_dir / ("scene-" + str(idx + 1) + ".jpg")
            clip_path = work_dir / ("clip-" + str(idx + 1) + ".mp4")
            create_visual_canvas(group, scene_assets[idx], idx, canvas_path, title, hook)
            render_one_scene(canvas_path, scene_duration, clip_path)
            clips.append(clip_path)
            update_job(job_id, progress=70 + int(20 * (idx + 1) / max(1, len(groups))), message="Sahneler birleştiriliyor… (" + str(idx + 1) + "/" + str(len(groups)) + ")")
        list_file = work_dir / "clips.txt"
        list_file.write_text("".join("file '" + str(p) + "'\n" for p in clips), encoding="utf-8")
        output_video = work_dir / "shorts.mp4"
        update_job(job_id, progress=92, message="Ses ve görüntü senkronize edilerek MP4 oluşturuluyor…")
        final_result = run_command([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-i", str(cleaned_audio), "-map", "0:v:0", "-map", "1:a:0",
            "-t", str(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart", str(output_video)
        ], timeout=900)
        if final_result.returncode != 0 or not output_video.exists():
            raise RuntimeError("MP4 birleştirme başarısız: " + final_result.stderr[-1200:])
        credits = [
            "CONTENT FACTORY — KAYNAK VE LİSANS KAYDI",
            "Video başlığı: " + title,
            "Süre: " + str(round(duration, 2)) + " saniye",
            "Temizlenen sessizlik: " + str(round(removed, 2)) + " saniye",
            "",
            "Kullanılan medya:",
        ]
        if source_records:
            for item in source_records:
                credits.extend([
                    "- " + item.get("title", "Adsız dosya"),
                    "  Kaynak: " + (item.get("source") or "Açık görsel koleksiyonu"),
                    "  Sanatçı: " + (item.get("author") or "Belirtilmemiş"),
                    "  Lisans: " + (item.get("license") or "Belirtilmemiş"),
                    "  Lisans bağlantısı: " + (item.get("license_url") or "Belirtilmemiş"),
                    "  Kaynak: " + (item.get("page_url") or ""),
                    "",
                ])
        else:
            credits.append("Bu render sırasında uygun lisanslı Wikimedia Commons görseli bulunamadı; ilgili sahnelerde özgün grafik kompozisyonları kullanıldı.")
        credits.extend([
            "",
            "Ses motoru: MOSS-TTS-Nano (ONNX CPU). Model ve tokenizer lisans/atıf bilgileri için:",
            "https://github.com/OpenMOSS/MOSS-TTS-Nano",
            "https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX",
            "https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX",
            "",
            "Not: Görseller Wikimedia Commons, Openverse ve Library of Congress gibi kamuya açık koleksiyonlardan aranır. Her varlığın kendi lisans koşulları yukarıda listelenir.",
        ])
        (work_dir / "sources-and-licenses.txt").write_text("\n".join(credits), encoding="utf-8")
        update_job(
            job_id, status="completed", progress=100, message="Shorts MP4 hazır.",
            duration=round(probe_duration(output_video), 2), removed_silence=round(removed, 2),
            scene_count=len(clips), source_count=len(source_records),
        )
    except Exception as exc:
        traceback.print_exc()
        update_job(job_id, status="failed", progress=100, message="Render başarısız.", error=str(exc)[:2000])


def cleanup_old_jobs() -> None:
    now = time.time()
    with JOBS_LOCK:
        expired = [key for key, value in JOBS.items() if now - float(value.get("updated_at", now)) > JOB_TTL_SECONDS]
        for key in expired:
            value = JOBS.pop(key, None)
            if value:
                shutil.rmtree(value.get("directory", ""), ignore_errors=True)


# ---- YouTube Agent Hub bridge (no Claude/LLM API required) ----
AGENT_DIR = APP_DIR.parent / "agent"
AGENT_TOOLS = {
    "hookscore": "hookscore.py",
    "title": "title.py",
    "deadair": "deadair.py",
    "chapters": "chapters.py",
    "retention": "retention.py",
    "viral": "swipe.py",
}

@app.get("/api/agent/registry")
async def agent_registry(_auth: None = Depends(require_access)) -> dict[str, Any]:
    registry_path = AGENT_DIR / "registry.json"
    if not registry_path.is_file():
        raise HTTPException(status_code=503, detail="YouTube Agent Hub dosyaları bulunamadı.")
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    return {
        "name": registry.get("name"),
        "version": registry.get("version"),
        "management": registry.get("management"),
        "skills": registry.get("skills", []),
        "tools": sorted(AGENT_TOOLS.keys()),
    }

@app.get("/api/agent/skills/{skill_id}")
async def agent_skill(skill_id: str, _auth: None = Depends(require_access)) -> dict[str, Any]:
    if not re.fullmatch(r"yt-[a-z-]+", skill_id):
        raise HTTPException(status_code=400, detail="Geçersiz uzmanlık kimliği.")
    skill_path = AGENT_DIR / "skills" / (skill_id + ".md")
    if not skill_path.is_file():
        raise HTTPException(status_code=404, detail="Uzmanlık kılavuzu bulunamadı.")
    return {"id": skill_id, "content": skill_path.read_text(encoding="utf-8")}

@app.post("/api/agent/run")
async def agent_run(request: Request, _auth: None = Depends(require_access)) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Geçersiz JSON isteği.")
    tool = str(payload.get("tool", "")).strip()
    if tool not in AGENT_TOOLS:
        raise HTTPException(status_code=400, detail="İzin verilmeyen ajan aracı.")
    params = payload.get("params") or {}
    if not isinstance(params, dict):
        raise HTTPException(status_code=400, detail="Araç parametreleri nesne olmalı.")
    args = [os.getenv("PYTHON", "python"), str(AGENT_DIR / "tools" / AGENT_TOOLS[tool]), "--json"]
    temp_path = None
    try:
        if tool == "hookscore":
            hook = str(params.get("hook", "")).strip()
            if not hook or len(hook) > 500:
                raise HTTPException(status_code=400, detail="Kanca metni 1–500 karakter olmalı.")
            args += ["--hook", hook]
        elif tool == "title":
            title = str(params.get("title", "")).strip()
            thumb = str(params.get("thumb", "")).strip()
            if not title or len(title) > 120 or len(thumb) > 80:
                raise HTTPException(status_code=400, detail="Başlık 1–120, kapak metni en fazla 80 karakter olmalı.")
            args += ["--title", title]
            if thumb: args += ["--thumb", thumb]
        else:
            file_field = {"deadair": "srt", "chapters": "srt", "retention": "csv", "viral": "json"}[tool]
            content = str(params.get(file_field, "")).strip()
            if not content or len(content.encode("utf-8")) > 2 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="Gerekli dosya içeriği boş veya 2 MB sınırını aşıyor.")
            suffix = {"deadair": ".srt", "chapters": ".srt", "retention": ".csv", "viral": ".json"}[tool]
            with tempfile.NamedTemporaryFile("w", suffix=suffix, encoding="utf-8", delete=False) as tmp:
                tmp.write(content); temp_path = tmp.name
            args.append(temp_path)
            if tool == "deadair":
                floor = float(params.get("floor", 0.45))
                if not 0.1 <= floor <= 3: raise HTTPException(status_code=400, detail="Sessizlik eşiği 0.1–3 saniye olmalı.")
                args += ["--floor", str(floor)]
            if tool == "chapters":
                target = int(params.get("target", 7))
                if not 3 <= target <= 20: raise HTTPException(status_code=400, detail="Bölüm sayısı 3–20 arasında olmalı.")
                args += ["--target", str(target)]
            if tool == "retention":
                duration = float(params.get("duration", 0) or 0)
                if duration > 0:
                    if duration > 86400: raise HTTPException(status_code=400, detail="Video süresi geçersiz.")
                    args += ["--duration", str(duration)]
        result = subprocess.run(args, capture_output=True, text=True, timeout=45, cwd=str(AGENT_DIR))
        if result.returncode != 0:
            raise HTTPException(status_code=422, detail=(result.stderr or result.stdout or "Araç çalıştırılamadı.")[-1500:])
        try: output = json.loads(result.stdout)
        except Exception: output = {"text": result.stdout}
        return {"ok": True, "tool": tool, "result": output}
    except HTTPException:
        raise
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Ajan aracı zaman aşımına uğradı.")
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Ajan aracı hatası: " + str(exc)[:500])
    finally:
        if temp_path:
            try: os.unlink(temp_path)
            except OSError: pass
