from __future__ import annotations

import html
import json
import os
import random
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from urllib.parse import quote_plus, unquote
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import httpx
import requests
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
from editing_agent import (
    build_edit_plan,
    build_visual_beats,
    remap_rows_to_edited_timeline,
    render_edited_audio,
    write_ass_subtitles,
)

APP_DIR = Path(__file__).resolve().parent
TTS_INTERNAL_URL = os.getenv("TTS_INTERNAL_URL", "http://127.0.0.1:18083").rstrip("/")
API_TOKEN = os.getenv("FACTORY_API_TOKEN", "")
ASR_MODEL = os.getenv("ASR_MODEL_SIZE", "tiny")
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
POOL = ThreadPoolExecutor(max_workers=max(1, int(os.getenv("RENDER_JOB_WORKERS", "2"))), thread_name_prefix="cf-render")
ASR_MODEL_INSTANCE = None
ASR_MODEL_LOCK = threading.Lock()


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
    """Remove leading silence and shorten long pauses before transcription and scene timing."""
    filt = (
        "silenceremove=start_periods=1:start_duration=0.12:start_threshold=-40dB:"
        "start_silence=0.04:stop_periods=-1:stop_duration=0.18:"
        "stop_threshold=-40dB:stop_silence=0.08:detection=rms:window=0.02"
    )
    result = run_command([
        "ffmpeg", "-y", "-i", str(source), "-vn", "-af", filt,
        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(output)
    ], timeout=240)
    if result.returncode != 0 or not output.exists() or output.stat().st_size < 1024:
        shutil.copy2(source, output)
    original_duration = probe_duration(source)
    cleaned_duration = probe_duration(output)
    if cleaned_duration > original_duration + 0.05:
        shutil.copy2(source, output)
        cleaned_duration = original_duration
    return max(0.0, original_duration - cleaned_duration)

def transcribe_audio(audio_path: Path) -> list[dict[str, Any]]:
    """Transcribe Turkish narration into individual word timings for edit decisions."""
    global ASR_MODEL_INSTANCE
    from faster_whisper import WhisperModel
    with ASR_MODEL_LOCK:
        if ASR_MODEL_INSTANCE is None:
            ASR_MODEL_INSTANCE = WhisperModel(
                ASR_MODEL, device="cpu", compute_type="int8",
                cpu_threads=max(1, int(os.getenv("CPU_THREADS", "2")))
            )
        model = ASR_MODEL_INSTANCE
    segments, _info = model.transcribe(
        str(audio_path), language="tr", beam_size=1, vad_filter=True,
        word_timestamps=True, condition_on_previous_text=False
    )
    rows: list[dict[str, Any]] = []
    for seg in segments:
        words = list(getattr(seg, "words", None) or [])
        if not words:
            text = (seg.text or "").strip()
            if text and float(seg.end) > float(seg.start):
                rows.append({"start": float(seg.start), "end": float(seg.end), "text": text})
            continue
        for word in words:
            token = str(word.word or "").strip()
            if not token:
                continue
            start = float(word.start if word.start is not None else seg.start)
            end = float(word.end if word.end is not None else seg.end)
            if end > start:
                rows.append({"start": start, "end": end, "text": token})
    rows.sort(key=lambda item: (float(item["start"]), float(item["end"])))
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
    """Build caption beats from Whisper timestamps without redistributing speech over the whole file."""
    minimum_beat = 1.35
    groups: list[dict[str, Any]] = []

    for row in rows:
        text = re.sub(r"\s+", " ", str(row.get("text", "")).strip())
        start = max(0.0, min(duration, float(row.get("start", 0.0))))
        end = max(start + 0.08, min(duration, float(row.get("end", start + 0.5))))
        if not text:
            continue

        clauses = [part.strip() for part in re.split(r"(?<=[.!?;,:])\s+", text) if part.strip()] or [text]
        chunks: list[str] = []
        for clause in clauses:
            words = clause.split()
            for offset in range(0, len(words), 7):
                chunk = " ".join(words[offset:offset + 7]).strip()
                if chunk:
                    chunks.append(chunk)
        if not chunks:
            continue

        weights = [max(1, len(part.split())) for part in chunks]
        total_weight = sum(weights)
        row_span = max(0.08, end - start)
        cursor = start
        for index, (part, weight) in enumerate(zip(chunks, weights)):
            part_end = end if index == len(chunks) - 1 else cursor + row_span * weight / total_weight
            groups.append({"start": cursor, "end": max(cursor + 0.08, part_end), "text": part})
            cursor = part_end

    if not groups:
        return fallback_segments("", duration)

    groups.sort(key=lambda item: float(item["start"]))
    # Merge very short beats into the closest neighbour; never stretch captions
    # proportionally across the whole narration, because that destroys word sync.
    while len(groups) > 1:
        spans = [max(0.0, float(item["end"]) - float(item["start"])) for item in groups]
        short_indices = [i for i, span in enumerate(spans) if span < minimum_beat]
        max_groups = max(1, int(duration / minimum_beat))
        if not short_indices and len(groups) <= max_groups:
            break
        index = min(short_indices or range(len(groups)), key=lambda i: spans[i])
        if index == 0:
            neighbour = 1
        elif index == len(groups) - 1:
            neighbour = index - 1
        else:
            left_gap = max(0.0, float(groups[index]["start"]) - float(groups[index - 1]["end"]))
            right_gap = max(0.0, float(groups[index + 1]["start"]) - float(groups[index]["end"]))
            neighbour = index - 1 if left_gap <= right_gap else index + 1
        left, right = sorted((index, neighbour))
        groups[left]["text"] = (str(groups[left]["text"]).strip() + " " + str(groups[right]["text"]).strip()).strip()
        groups[left]["end"] = max(float(groups[left]["end"]), float(groups[right]["end"]))
        groups.pop(right)

    # Give short residual pauses to the preceding caption so the visual timeline
    # covers the full cleaned audio while each caption still follows ASR timing.
    groups[0]["start"] = 0.0
    for index in range(1, len(groups)):
        previous = groups[index - 1]
        current = groups[index]
        previous_end = float(previous["end"])
        current_start = float(current["start"])
        boundary = current_start if current_start <= previous_end else (previous_end + current_start) / 2.0
        previous["end"] = max(float(previous["start"]) + 0.08, boundary)
        current["start"] = previous["end"]
    groups[-1]["end"] = duration
    for group in groups:
        group["start"] = max(0.0, min(duration, float(group["start"])))
        group["end"] = max(group["start"] + 0.08, min(duration, float(group["end"])))
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
        "prop": "imageinfo", "iiprop": "url|extmetadata|mime|size", "iiurlwidth": "1600",
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


def search_pexels(query: str, limit: int = 20) -> list[dict[str, str]]:
    key = os.getenv("PEXELS_API_KEY", "").strip()
    if not key: return []
    try:
        r = requests.get("https://api.pexels.com/v1/search", params={"query": query, "per_page": min(80, limit), "orientation": "portrait"}, headers={"Authorization": key, "User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        photos = r.json().get("photos", [])
    except Exception: return []
    return [{"title": plain_text(x.get("alt") or query), "url": x.get("src", {}).get("large2x") or x.get("src", {}).get("large") or x.get("src", {}).get("original", ""), "page_url": x.get("url", ""), "author": x.get("photographer", "Unknown"), "license": "Pexels License – review current terms", "license_url": "https://www.pexels.com/license/", "credit": x.get("photographer", ""), "mime": "image/unknown", "source": "Pexels"} for x in photos]


def search_pixabay(query: str, limit: int = 20) -> list[dict[str, str]]:
    key = os.getenv("PIXABAY_API_KEY", "").strip()
    if not key: return []
    try:
        r = requests.get("https://pixabay.com/api/", params={"key": key, "q": query, "image_type": "photo", "orientation": "vertical", "per_page": min(200, limit), "safesearch": "true"}, headers={"User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        hits = r.json().get("hits", [])
    except Exception: return []
    return [{"title": plain_text(x.get("tags") or query), "url": x.get("largeImageURL") or x.get("webformatURL", ""), "page_url": x.get("pageURL", ""), "author": x.get("user", "Unknown"), "license": "Pixabay Content License – review current terms", "license_url": "https://pixabay.com/service/license-summary/", "credit": x.get("user", ""), "mime": "image/unknown", "source": "Pixabay"} for x in hits]


def search_unsplash(query: str, limit: int = 20) -> list[dict[str, str]]:
    key = os.getenv("UNSPLASH_ACCESS_KEY", "").strip()
    if not key: return []
    try:
        r = requests.get("https://api.unsplash.com/search/photos", params={"query": query, "per_page": min(30, limit), "orientation": "portrait"}, headers={"Authorization": "Client-ID " + key, "User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        photos = r.json().get("results", [])
    except Exception: return []
    items = []
    for x in photos:
        user = x.get("user") or {}
        items.append({"title": plain_text(x.get("alt_description") or x.get("description") or query), "url": (x.get("urls") or {}).get("regular", ""), "page_url": (x.get("links") or {}).get("html", ""), "author": user.get("name", "Unknown"), "license": "Unsplash License – review current terms", "license_url": "https://unsplash.com/license", "credit": user.get("name", ""), "mime": "image/unknown", "source": "Unsplash"})
    return items


def search_flickr(query: str, limit: int = 20) -> list[dict[str, str]]:
    key = os.getenv("FLICKR_API_KEY", "").strip()
    if not key: return []
    try:
        r = requests.get("https://www.flickr.com/services/rest/", params={"method": "flickr.photos.search", "api_key": key, "text": query, "per_page": min(100, limit), "page": 1, "format": "json", "nojsoncallback": 1, "media": "photos", "sort": "relevance", "extras": "url_o,url_l,url_c,owner_name,license"}, headers={"User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        photos = r.json().get("photos", {}).get("photo", [])
    except Exception: return []
    return [{"title": plain_text(x.get("title") or query), "url": x.get("url_o") or x.get("url_l") or x.get("url_c") or "", "page_url": "https://www.flickr.com/photos/" + str(x.get("owner")) + "/" + str(x.get("id")), "author": x.get("ownername", "Unknown"), "license": "Flickr license ID " + str(x.get("license", "unknown")) + " – verify on source page", "license_url": "https://www.flickr.com/services/api/flickr.photos.licenses.getInfo.html", "credit": x.get("ownername", ""), "mime": "image/unknown", "source": "Flickr"} for x in photos]


def search_nasa(query: str, limit: int = 20) -> list[dict[str, str]]:
    try:
        r = requests.get("https://images-api.nasa.gov/search", params={"q": query, "media_type": "image", "page_size": min(100, limit)}, headers={"User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        rows = r.json().get("collection", {}).get("items", [])
    except Exception: return []
    items = []
    for row in rows:
        data = (row.get("data") or [{}])[0]
        links = row.get("links") or []
        image_url = next((x.get("href", "") for x in links if x.get("rel") == "preview"), "")
        if image_url:
            items.append({"title": plain_text(data.get("title") or query), "url": image_url, "page_url": data.get("nasa_id") and "https://images.nasa.gov/details/" + str(data["nasa_id"]) or "", "author": "NASA", "license": "NASA media usage guidance – review item-specific restrictions", "license_url": "https://www.nasa.gov/nasa-brand-center/images-and-media/", "credit": "NASA", "mime": "image/unknown", "source": "NASA"})
    return items


def search_europeana(query: str, limit: int = 20) -> list[dict[str, str]]:
    key = os.getenv("EUROPEANA_API_KEY", "").strip()
    if not key: return []
    try:
        r = requests.get("https://api.europeana.eu/record/v2/search.json", params={"wskey": key, "query": query, "media": "true", "thumbnail": "true", "rows": min(100, limit)}, headers={"User-Agent": USER_AGENT}, timeout=15)
        r.raise_for_status()
        rows = r.json().get("items", [])
    except Exception: return []
    return [{"title": plain_text(x.get("title", [query])[0] if isinstance(x.get("title"), list) else x.get("title") or query), "url": x.get(" edmPreview") or x.get("edmPreview", ""), "page_url": x.get("guid", ""), "author": plain_text((x.get("dcCreator") or ["Unknown"])[0]), "license": str(x.get("rights", ["Unknown"])[0]), "license_url": str(x.get("rights", [""])[0]), "credit": plain_text((x.get("dataProvider") or [""])[0]), "mime": "image/unknown", "source": "Europeana"} for x in rows if x.get("edmPreview")]


def search_duckduckgo_images(query: str, limit: int = 20) -> list[dict[str, str]]:
    """Best-effort keyless DuckDuckGo image search; may be throttled or changed upstream."""
    try:
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
        landing = requests.get("https://duckduckgo.com/", params={"q": query, "iax": "images", "ia": "images"}, headers=headers, timeout=15)
        landing.raise_for_status()
        match = re.search(r'vqd=([\'"])(.*?)\1', landing.text) or re.search(r"vqd=([^&\"']+)", landing.text)
        if not match:
            return []
        vqd = match.group(2) if match.lastindex and match.lastindex >= 2 else match.group(1)
        response = requests.get("https://duckduckgo.com/i.js", params={"l": "us-en", "o": "json", "q": query, "vqd": vqd, "f": ",,,", "p": "1"}, headers={**headers, "Referer": landing.url}, timeout=15)
        response.raise_for_status()
        rows = response.json().get("results", [])
    except Exception:
        return []
    items = []
    for row in rows:
        image_url = row.get("image") or row.get("thumbnail")
        if not image_url:
            continue
        items.append({
            "title": plain_text(row.get("title") or query),
            "url": image_url,
            "page_url": row.get("url") or "",
            "author": plain_text(row.get("source") or "Unknown"),
            "license": "Unknown – verify usage rights before publication",
            "license_url": "",
            "credit": plain_text(row.get("source") or ""),
            "mime": "image/unknown",
            "source": "DuckDuckGo Images",
        })
        if len(items) >= limit:
            break
    return items


def search_web_image_engine(engine: str, query: str, limit: int = 20) -> list[dict[str, str]]:
    """Fetch publicly accessible image results from mainstream image search pages.
    Search engines may throttle automated requests; failures are isolated per provider.
    """
    encoded = quote_plus(query)
    endpoints = {
        "Google Images": "https://www.google.com/search?tbm=isch&q=" + encoded,
        "Bing Images": "https://www.bing.com/images/search?q=" + encoded,
        "Yandex Images": "https://yandex.com/images/search?text=" + encoded,
    }
    endpoint = endpoints.get(engine)
    if not endpoint:
        return []
    try:
        response = requests.get(
            endpoint,
            headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=20,
        )
        response.raise_for_status()
        page = html.unescape(response.text).replace("\\u0026", "&").replace("\\/", "/")
    except Exception:
        return []

    patterns = {
        "Google Images": [r'"ou":"(https?://[^"]+)"', r'"imageUrl":"(https?://[^"]+)"'],
        "Bing Images": [r'"murl":"(https?://[^"]+)"'],
        "Yandex Images": [r'"img_href":"(https?://[^"]+)"', r'"origUrl":"(https?://[^"]+)"'],
    }
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    for pattern in patterns[engine]:
        for raw_url in re.findall(pattern, page, re.I):
            url = unquote(raw_url).replace("\\u0026", "&").replace("\\/", "/")
            url = url.replace("&amp;", "&")
            if not url.startswith("https://") or url in seen:
                continue
            if any(bad in url.lower() for bad in ("gstatic.com", "bing.com/th", "yandex.net/i")):
                continue
            seen.add(url)
            found.append({
                "title": query,
                "url": url,
                "page_url": endpoint,
                "author": "Not identified by image search",
                "license": "Unknown – verify usage rights before publication",
                "license_url": "",
                "credit": "",
                "mime": "image/unknown",
                "source": engine,
            })
            if len(found) >= limit:
                return found
    return found


def translate_visual_query(query: str) -> str:
    """Best-effort Turkish-to-English query translation for international image indexes."""
    value = re.sub(r"\s+", " ", str(query or "")).strip()
    if not value:
        return value
    if not re.search(r"[çğıöşü]", value.lower()) and not re.search(
        r"\b(ve|bir|için|olan|hakkında|nasıl|neden|ünlülerin|hikayesi)\b",
        value.lower(),
    ):
        return value
    try:
        response = requests.get(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": "tr", "tl": "en", "dt": "t", "q": value[:450]},
            headers={"User-Agent": USER_AGENT},
            timeout=(3, 6),
        )
        response.raise_for_status()
        payload = response.json()
        translated = " ".join(
            str(part[0]) for part in (payload[0] or [])
            if isinstance(part, list) and part and part[0]
        ).strip()
        return translated or value
    except Exception as exc:
        print("[visual-search] translation fallback:", type(exc).__name__, str(exc)[:180])
        return value


def search_public_assets(query: str, limit: int = 30) -> list[dict[str, str]]:
    """Federated image research with diagnostics and an English-query fallback."""
    search_query = translate_visual_query(query)
    providers = [
        search_pexels, search_pixabay, search_unsplash, search_flickr,
        search_openverse, search_commons, search_library_of_congress,
        search_nasa, search_europeana, search_duckduckgo_images,
        lambda q, n: search_web_image_engine("Google Images", q, n),
        lambda q, n: search_web_image_engine("Bing Images", q, n),
        lambda q, n: search_web_image_engine("Yandex Images", q, n),
    ]
    results: list[dict[str, str]] = []
    seen: set[str] = set()
    per_provider = max(8, min(24, limit))
    provider_counts: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=min(10, len(providers))) as pool:
        futures = {pool.submit(provider, search_query, per_provider): provider.__name__ for provider in providers}
        try:
            for future in as_completed(futures, timeout=18):
                provider_name = futures[future]
                try:
                    items = future.result()
                    provider_counts[provider_name] = len(items or [])
                except Exception as exc:
                    provider_counts[provider_name] = -1
                    print("[visual-search] provider failure:", provider_name, type(exc).__name__, str(exc)[:180])
                    continue
                for item in items or []:
                    url = str(item.get("url") or "").strip()
                    if not url or url in seen:
                        continue
                    seen.add(url)
                    results.append(item)
        except TimeoutError:
            unfinished = [name for future, name in futures.items() if not future.done()]
            print("[visual-search] provider timeout:", ",".join(unfinished))
    ranked = sorted(
        results,
        key=lambda item: visual_relevance_score(search_query, item),
        reverse=True,
    )
    print(
        "[visual-search] query=", search_query[:120],
        "providers=", json.dumps(provider_counts, ensure_ascii=False),
        "results=", len(ranked),
    )
    return ranked[:limit]


VISUAL_ENGLISH_WORDS = {
    "köpek": "dog", "köpeği": "dog", "köpeğin": "dog", "köpekler": "dogs",
    "köpeklerin": "dogs", "kedi": "cat", "kedisi": "cat", "kediler": "cats",
    "rocky": "Rocky", "balboa": "Balboa", "butkus": "Butkus",
    "stallone": "Sylvester Stallone", "senaryo": "screenplay", "senaryoyu": "screenplay",
    "oyuncu": "actor", "oyuncunun": "actor", "film": "film", "filmi": "film",
    "dolar": "money", "para": "money", "teklif": "offer", "tarih": "history",
    "tarihi": "historical", "savaş": "war", "savaşı": "war", "uçak": "aircraft",
    "uzay": "space", "gezegen": "planet", "şehir": "city", "araba": "car",
    "otomobil": "car", "insan": "person", "insanlar": "people", "hayvan": "animal",
    "hayvanlar": "animals", "deniz": "sea", "okyanus": "ocean", "bilim": "science",
    "teknoloji": "technology", "robot": "robot", "robotlar": "robots",
    "deprem": "earthquake", "yangın": "fire", "orman": "forest", "kaza": "accident",
    "spor": "sports", "futbol": "football", "müzik": "music", "sanat": "art",
    "mısır": "Egypt", "roma": "Rome", "paris": "Paris", "istanbul": "Istanbul"
}
VISUAL_QUERY_STOP = STOP_WORDS | {
    "nin", "nın", "nun", "nün", "ın", "in", "un", "ün", "a", "e", "ya", "ye", "dan", "den", "dır", "dir", "dur",
    "bugün", "akla", "gelir", "denildiğinde", "efsanevi", "karakter", "aslında", "daha", "önce", "sonra",
    "etti", "etmiş", "oldu", "olmuş", "olarak", "yapımcılar", "hikayeyi", "hikâyesi", "birçok", "binlerce",
}
VISUAL_ENGLISH_STOP = {"the", "and", "for", "with", "from", "that", "this", "before", "after", "about", "when", "what", "were", "was", "his", "her", "their"}


def visual_relevance_score(query: str, item: dict[str, str]) -> int:
    query_tokens = {
        token for token in re.findall(r"[a-z0-9]+", (query or "").lower())
        if len(token) >= 3 and token not in VISUAL_ENGLISH_STOP
    }
    candidate_text = " ".join([
        str(item.get("title") or ""),
        str(item.get("page_url") or ""),
        str(item.get("author") or ""),
    ]).lower()
    candidate_tokens = set(re.findall(r"[a-z0-9]+", candidate_text))
    overlap = query_tokens & candidate_tokens
    strong_overlap = {token for token in overlap if len(token) >= 6}
    return len(overlap) * 2 + len(strong_overlap) * 2


def english_visual_query(text: str) -> str:
    tokens = re.findall(r"[A-Za-zÇĞİÖŞÜçğıöşü0-9]+", (text or "").lower())
    output: list[str] = []
    for token in tokens:
        if len(token) < 3 or token in VISUAL_QUERY_STOP:
            continue
        translated = VISUAL_ENGLISH_WORDS.get(token, token)
        if translated not in output:
            output.append(translated)
        if len(output) >= 9:
            break
    return " ".join(output)


def visual_search_queries(title: str, hook: str, script: str) -> list[str]:
    candidates = [
        english_visual_query(title),
        english_visual_query(hook),
        english_visual_query(title + " " + script[:260]),
        extract_keywords(title + " " + hook),
    ]
    result: list[str] = []
    for candidate in candidates:
        candidate = re.sub(r"\s+", " ", candidate).strip()
        if candidate and candidate.lower() not in {x.lower() for x in result}:
            result.append(candidate)
    return result


def contrast_ink(hex_color: str) -> str:
    try:
        value = hex_color.lstrip("#")
        red, green, blue = (int(value[i:i+2], 16) for i in (0, 2, 4))
        luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        return "#FFFFFF" if luminance < 145 else "#111111"
    except Exception:
        return "#111111"


def compact_scene_caption(text: str, max_words: int = 7, max_chars: int = 62) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    value = re.sub(r"^[\s•–—-]+", "", value)
    words = value.split()
    truncated = len(words) > max_words
    words = words[:max_words]
    value = " ".join(words)
    if len(value) > max_chars:
        value = value[:max_chars].rsplit(" ", 1)[0].rstrip(" ,;:")
        truncated = True
    if truncated:
        value = value.rstrip(" ,;:.") + "…"
    return value or "Öne çıkan detay"


def draw_centered_wrapped(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, box, fill: str, max_lines: int = 2) -> None:
    left, top, right, bottom = box
    lines = wrap_lines(draw, text, font, right - left - 54)[:max_lines]
    line_height = int(font.size * 1.12)
    total_height = len(lines) * line_height
    y = top + max(0, (bottom - top - total_height) // 2)
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        x = left + max(0, (right - left - (bbox[2] - bbox[0])) // 2)
        draw.text((x, y), line, font=font, fill=fill)
        y += line_height


def extract_keywords(text: str) -> str:
    words = re.findall(r"[A-Za-zÇĞİÖŞÜçğıöşü0-9]+", (text or "").lower())
    selected = []
    for word in words:
        if len(word) > 3 and word not in STOP_WORDS and word not in selected:
            selected.append(word)
        if len(selected) >= 6:
            break
    return " ".join(selected) or (text or "")[:80]


def download_image_asset(item: dict[str, str], directory: Path, index: int) -> Path | None:
    """Download and normalize a real image, tolerating imperfect provider MIME headers."""
    raw_path = directory / ("web-image-" + str(index) + "-source.bin")
    output_path = directory / ("web-image-" + str(index) + ".jpg")
    try:
        response = requests.get(
            item["url"],
            headers={"User-Agent": USER_AGENT, "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*"},
            timeout=(8, 22),
            stream=True,
        )
        response.raise_for_status()
        content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type in {"text/html", "application/json", "text/plain"}:
            print("[visual-search] non-image response:", item.get("source"), content_type, item.get("url", "")[:160])
            return None
        content = bytearray()
        for chunk in response.iter_content(1024 * 128):
            if chunk:
                content.extend(chunk)
                if len(content) > 18 * 1024 * 1024:
                    print("[visual-search] image exceeds size limit:", item.get("url", "")[:160])
                    return None
        if len(content) < 2048:
            return None
        raw_path.write_bytes(content)
        with Image.open(raw_path) as image:
            image.seek(0)
            image.load()
            if image.width < 480 or image.height < 360:
                return None
            image.convert("RGB").save(output_path, format="JPEG", quality=91, optimize=True)
        return output_path
    except Exception as exc:
        print(
            "[visual-search] download/decode failed:",
            item.get("source", "unknown"),
            type(exc).__name__,
            str(exc)[:220],
            str(item.get("url", ""))[:160],
        )
        return None
    finally:
        raw_path.unlink(missing_ok=True)



# Optional local CLIP vision-language reranker. It runs on CPU and downloads
# open weights on first use; if unavailable, scene search fails closed to a
# generated title card instead of silently substituting an unrelated photo.
_CLIP_MODEL = None
_CLIP_PROCESSOR = None
_CLIP_LOCK = threading.Lock()


def rank_scene_images(query: str, candidates: list[tuple[Path, dict[str, str]]]) -> list[tuple[float, tuple[Path, dict[str, str]]]]:
    if not candidates:
        return []
    try:
        import torch
        from transformers import CLIPModel, CLIPProcessor
        global _CLIP_MODEL, _CLIP_PROCESSOR
        with _CLIP_LOCK:
            if _CLIP_MODEL is None:
                model_name = os.getenv("VISUAL_MATCH_MODEL", "openai/clip-vit-base-patch32")
                _CLIP_PROCESSOR = CLIPProcessor.from_pretrained(model_name)
                _CLIP_MODEL = CLIPModel.from_pretrained(model_name)
                _CLIP_MODEL.eval()
        images = []
        valid = []
        for pair in candidates:
            try:
                with Image.open(pair[0]) as image:
                    images.append(image.convert("RGB").copy())
                valid.append(pair)
            except Exception:
                continue
        if not valid:
            return []
        prompts = [
            "A real photograph illustrating this scene: " + str(query)[:400],
            "A documentary image showing " + str(query)[:400],
        ]
        inputs = _CLIP_PROCESSOR(text=prompts, images=images, return_tensors="pt", padding=True)
        with torch.inference_mode():
            outputs = _CLIP_MODEL(**inputs)
            image_features = outputs.image_embeds
            text_features = outputs.text_embeds
            image_features = image_features / image_features.norm(dim=-1, keepdim=True)
            text_features = text_features / text_features.norm(dim=-1, keepdim=True)
            similarities = (image_features @ text_features.T).max(dim=1).values.cpu().tolist()
        ranked = sorted(zip(similarities, valid), key=lambda item: item[0], reverse=True)
        print("[visual-match] CLIP scores:", [(round(float(score), 3), pair[1].get("title", "")[:70]) for score, pair in ranked[:5]])
        return [(float(score), pair) for score, pair in ranked]
    except Exception as exc:
        print("[visual-match] local CLIP unavailable; using conservative metadata ranking:", type(exc).__name__, str(exc)[:240])
        return sorted(
            [(visual_relevance_score(query, pair[1]), pair) for pair in candidates],
            key=lambda item: item[0],
            reverse=True,
        )

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


def create_fallback_visual_asset(text: str, directory: Path, index: int) -> tuple[Path, dict[str, str]]:
    """Create a scene-specific graphic card only when all external image providers fail."""
    import hashlib
    value = re.sub(r"\s+", " ", str(text or "Öne çıkan detay")).strip()
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    palettes = [
        ("#111827", "#1D4ED8", "#7DD3FC"),
        ("#171717", "#7C2D12", "#FDBA74"),
        ("#111827", "#065F46", "#6EE7B7"),
        ("#1F1635", "#6D28D9", "#DDD6FE"),
        ("#24151C", "#9F1239", "#FDA4AF"),
    ]
    background, accent, light = palettes[digest[0] % len(palettes)]
    width, height = 1000, 1200
    start_rgb = tuple(int(background[i:i+2], 16) for i in (1, 3, 5))
    end_rgb = tuple(int(accent[i:i+2], 16) for i in (1, 3, 5))
    gradient = Image.new("RGB", (1, height))
    gradient.putdata([
        tuple(int(start_rgb[k] * (1 - y / max(1, height - 1)) + end_rgb[k] * (y / max(1, height - 1)) * 0.38) for k in range(3))
        for y in range(height)
    ])
    canvas = gradient.resize((width, height), Image.Resampling.BILINEAR)
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.ellipse((560, -180, 1180, 440), outline=(255,255,255,42), width=5)
    draw.ellipse((610, -130, 1130, 390), outline=(255,255,255,26), width=3)
    draw.ellipse((-260, 700, 480, 1440), outline=(255,255,255,35), width=5)
    draw.rounded_rectangle((64, 72, 350, 128), radius=18, fill=(255,255,255,24), outline=(255,255,255,60), width=2)
    draw.text((88, 86), "SCENE VISUAL", font=load_font(27), fill=light)
    draw.rounded_rectangle((64, 1020, 936, 1088), radius=20, fill=(0,0,0,65))
    draw.text((92, 1037), "CONTENT FACTORY  •  VISUAL BACKUP", font=load_font(22), fill=(255,255,255,210))
    words = value.split()
    lines = []
    line = ""
    font = load_font(62)
    for word in words:
        candidate = (line + " " + word).strip()
        if draw.textbbox((0,0), candidate, font=font)[2] > 820 and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    y = 360 if len(lines) <= 3 else 280
    for line in lines[:5]:
        draw.text((78, y), line, font=font, fill=(255,255,255,245), stroke_width=2, stroke_fill=(0,0,0,75))
        y += 82
    path = directory / ("generated-scene-fallback-" + str(index) + ".jpg")
    canvas.save(path, quality=92)
    metadata = {
        "title": value[:180],
        "author": "Content Factory",
        "license": "Generated graphic fallback; no third-party image",
        "license_url": "",
        "page_url": "",
        "url": "",
        "source": "Generated scene visual fallback",
    }
    return path, metadata


def create_visual_canvas(group: dict[str, Any], assets: list[tuple[Path, dict[str, str]]], index: int, output: Path, title: str, hook: str = "") -> None:
    """Balanced 9:16 editorial frame with a contained photo and clean caption panel."""
    width, height = 1080, 1920
    background = "#10151E"
    panel = "#1A2230"
    accent = "#E8B968"
    if not assets:
        raise RuntimeError("Bu sahne için doğrulanmış görsel bulunamadı.")
    try:
        with Image.open(assets[0][0]) as source:
            photo = cover_image(source, (944, 1160))
            dynamic_background = cover_image(source, (width, height)).filter(ImageFilter.GaussianBlur(34))
        dark_backdrop = Image.new("RGB", (width, height), background)
        canvas = Image.blend(dynamic_background, dark_backdrop, 0.78)
        canvas = ImageEnhance.Color(canvas).enhance(0.72)
    except Exception as exc:
        raise RuntimeError("Sahne görseli açılamadı: " + str(exc))

    draw = ImageDraw.Draw(canvas)

    # Topic title remains subtle; the hook appears only on the opening shot.
    eyebrow = load_font(30)
    draw.text((68, 58), re.sub(r"\s+", " ", str(title or "SHORTS")).strip()[:72], font=eyebrow, fill="#B9C4D3")
    draw.rectangle((68, 112, 1012, 118), fill=accent)
    if index == 0 and hook:
        hook_font = load_font(42)
        hook_lines = wrap_lines(draw, re.sub(r"\s+", " ", str(hook).strip()), hook_font, 920)[:2]
        y = 142
        for line in hook_lines:
            draw.text((72, y), line, font=hook_font, fill="#F6F7FA")
            y += 52

    # The photo is contained rather than filling the entire screen.
    image_box = (68, 300, 1012, 1460)
    canvas.paste(photo, (image_box[0], image_box[1]))
    draw = ImageDraw.Draw(canvas)
    draw_rounded_compat(draw, image_box, radius=26, outline="#344052", width=3)

    # The caption panel begins immediately below the image: no empty black footer.
    panel_box = (68, 1480, 1012, 1810)
    draw_rounded_compat(draw, panel_box, radius=28, fill=panel, outline="#293648", width=2)
    draw.rounded_rectangle((108, 1540, 118, 1760), radius=5, fill=accent)

    # The lower-third is intentionally left open for word-timed ASS captions.
    # Captions are rendered after the clips are concatenated, so their timing follows
    # the edited narration rather than being baked into a still frame.

    canvas.save(output, quality=95)

def render_one_scene(canvas: Path, duration: float, output: Path, audio_path: Path | None = None, audio_start: float = 0.0) -> None:
    # Alternating slow push-in / pull-out with gentle horizontal drift.
    zoom_expr = "min(zoom+0.00075,1.09)" if int(audio_start * 10) % 2 == 0 else "max(zoom-0.00075,1.0)"
    zoom = "zoompan=z='" + zoom_expr + "':x='iw/2-(iw/zoom/2)+10*sin(on/42)':y='ih/2-(ih/zoom/2)+8*cos(on/49)':d=1:s=1080x1920:fps=30"
    args = [
        "ffmpeg", "-y", "-loop", "1", "-i", str(canvas),
        "-t", str(max(0.6, duration)),
        "-vf", zoom + ",scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p",
        "-r", "30", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", str(output)
    ]
    result = run_command(args, timeout=300)
    if result.returncode != 0 or not output.exists():
        raise RuntimeError("Sahne render edilemedi: " + result.stderr[-900:])

def render_short_job(job_id: str) -> None:
    # The editing agent owns the narration timeline; every downstream visual and
    # caption timestamp is remapped to the exact edited WAV timeline.
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        work_dir = Path(job["directory"])
        script = job["text"]
        title = job["title"]
        hook = job.get("hook", "")
    try:
        source_audio = work_dir / job.get("source_audio", "approved-preview.wav")
        cleaned_audio = work_dir / "cleaned.wav"
        source_duration = probe_duration(source_audio)
        update_job(job_id, status="running", progress=8, message="Ses kelime kelime analiz ediliyor; kurgu kararları hazırlanıyor…")

        edit_report: dict[str, Any]
        try:
            original_rows = transcribe_audio(source_audio)
            if not original_rows:
                raise RuntimeError("Konuşma zaman kodu üretilemedi.")
            edit_plan = build_edit_plan(original_rows, source_duration)
            render_edited_audio(source_audio, cleaned_audio, edit_plan)
            rows = remap_rows_to_edited_timeline(original_rows, edit_plan)
            removed = float(edit_plan.get("removed_seconds", 0.0))
            duration = probe_duration(cleaned_audio)
            edit_report = edit_plan
            edit_report["rendered_duration"] = round(duration, 3)
        except Exception as edit_error:
            # Safe fallback: preserve the existing silence-removal path if ASR
            # timestamps or the multi-span FFmpeg render are unavailable.
            update_job(job_id, progress=18, message="Gelişmiş zaman çizelgesi kullanılamadı; güvenli ses temizleme yedeği devrede…")
            removed = trim_silence(source_audio, cleaned_audio)
            duration = probe_duration(cleaned_audio)
            rows = fallback_segments(script, duration)
            edit_report = {
                "version": 1,
                "strategy": "legacy-silenceremove-fallback",
                "fallback_reason": str(edit_error)[:500],
                "source_duration": round(source_duration, 3),
                "output_duration": round(duration, 3),
                "removed_seconds": round(removed, 3),
                "cuts": [],
                "decisions": [{"type": "fallback", "reason": "word_alignment_or_audio_edit_unavailable"}],
            }

        if duration < 8:
            raise RuntimeError("Ses çok kısa. Lütfen daha uzun bir seslendirme üret.")
        if not rows:
            rows = fallback_segments(script, duration)

        update_job(job_id, progress=28, message="Cümle ritmi, altyazı ve görsel sahne süreleri hesaplanıyor…")
        groups = build_visual_beats(rows, duration, max_words=7, max_seconds=2.8)
        if not groups:
            groups = fallback_segments(script, duration)

        # Persist a compact, inspectable edit decision list for diagnostics.
        (work_dir / "edit-decision-list.json").write_text(
            json.dumps({
                **edit_report,
                "scene_count": len(groups),
                "caption_count": len(groups),
                "target_pause_policy": "0.16s after sentence; 0.22s after long intra-phrase pause",
                "scene_timeline": [
                    {
                        "start": round(float(g.get("start", 0.0)), 3),
                        "end": round(float(g.get("end", 0.0)), 3),
                        "speech_start": round(float(g.get("speech_start", g.get("start", 0.0))), 3),
                        "speech_end": round(float(g.get("speech_end", g.get("end", 0.0))), 3),
                        "text": str(g.get("text", "")),
                    }
                    for g in groups
                ],
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        update_job(job_id, progress=34, message="Her cümle için anlatıma uygun görseller aranıyor…")
        source_records: list[dict[str, str]] = []
        scene_assets: list[list[tuple[Path, dict[str, str]]]] = []
        used_scene_paths: set[Path] = set()
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

        # Build a topic-specific reserve before rendering individual scenes.
        # This prevents a single weak scene query from aborting the entire video.
        seen_asset_urls: set[str] = set()
        downloaded_assets: list[tuple[Path, dict[str, str]]] = []
        query_cache: dict[str, list[dict[str, str]]] = {}
        topic_queries = visual_search_queries(title, hook, script)
        topic_anchor = english_visual_query(title + " " + hook)
        if topic_anchor and topic_anchor not in topic_queries:
            topic_queries.insert(0, topic_anchor)
        if not topic_queries:
            topic_queries = [extract_keywords(title + " " + hook + " " + script[:300])]

        for topic_query in topic_queries[:3]:
            if not topic_query:
                continue
            candidates = search_public_assets(topic_query, limit=36)
            query_cache[topic_query] = candidates
            for candidate in candidates:
                url = str(candidate.get("url") or "").strip()
                if not url or url in seen_asset_urls:
                    continue
                asset_path = download_image_asset(candidate, work_dir, len(source_records) + 1)
                if not asset_path:
                    continue
                seen_asset_urls.add(url)
                source_records.append(candidate)
                downloaded_assets.append((asset_path, candidate))
                if len(downloaded_assets) >= max(12, min(36, len(groups) * 2)):
                    break
            if len(downloaded_assets) >= max(12, min(36, len(groups) * 2)):
                break

        for idx, group in enumerate(groups):
            scene_text = re.sub(r"\s+", " ", str(group.get("text", "")).strip())
            scene_terms = translate_visual_query(scene_text) or english_visual_query(scene_text) or extract_keywords(scene_text)
            # Keep each search focused on the actual narration beat. Retry with
            # a simpler query if the first result set is empty or irrelevant.
            query_variants = []
            for query in (scene_terms, translate_visual_query(title + " " + scene_text), english_visual_query(scene_text), extract_keywords(scene_text)):
                query = re.sub(r"\s+", " ", str(query or "")).strip()
                if query and query.lower() not in {x.lower() for x in query_variants}:
                    query_variants.append(query[:160])

            scene_pairs: list[tuple[Path, dict[str, str]]] = []
            for query_attempt, scene_query in enumerate(query_variants[:3]):
                cache_key = re.sub(r"\s+", " ", scene_query.lower()).strip()
                candidates = query_cache.get(cache_key)
                if candidates is None:
                    try:
                        candidates = search_public_assets(scene_query, limit=24)
                        query_cache[cache_key] = candidates
                    except Exception as search_error:
                        print("[visual-search] scene query failed:", idx + 1, type(search_error).__name__, str(search_error)[:180])
                        candidates = []
                        query_cache[cache_key] = []
                for candidate in candidates[:16]:
                    url = str(candidate.get("url") or "").strip()
                    if not url or url in seen_asset_urls:
                        continue
                    asset_path = download_image_asset(candidate, work_dir, len(source_records) + 1)
                    if not asset_path:
                        continue
                    seen_asset_urls.add(url)
                    source_records.append(candidate)
                    pair = (asset_path, candidate)
                    downloaded_assets.append(pair)
                    scene_pairs.append(pair)
                if len(scene_pairs) >= 3:
                    break
                print("[visual-search] retrying scene with alternate query:", idx + 1, query_attempt + 1, scene_query)

            # Rank only images discovered for this beat. Do not pull a random
            # image from the video-wide reserve when scene relevance is weak.
            selected: tuple[Path, dict[str, str]] | None = None
            ranked_scene = rank_scene_images(scene_terms, scene_pairs)
            if not ranked_scene:
                # A broader topic result may be used only if the local vision
                # model confirms it depicts this exact beat; never random-pick.
                reserve_candidates = [pair for pair in downloaded_assets if pair not in scene_pairs]
                ranked_scene = rank_scene_images(scene_terms, reserve_candidates)
            if ranked_scene:
                # Never reuse the same downloaded photograph in two scenes.
                # Try the next semantically ranked candidate instead.
                for score, pair in ranked_scene:
                    min_score = 0.18 if isinstance(score, float) and score < 1 else 4
                    if score >= min_score and pair[0] not in used_scene_paths:
                        selected = pair
                        used_scene_paths.add(pair[0])
                        break
                if selected is None:
                    best_score = ranked_scene[0][0]
                    print("[visual-match] no unused relevant candidate passed threshold:", idx + 1, round(float(best_score), 3))
            else:
                selected = None

            # An explicitly uploaded reference image is allowed as a fallback;
            # otherwise create a scene-specific graphic, never an unrelated photo.
            if selected is None and user_images:
                own_path = user_images[idx % len(user_images)]
                selected = (own_path, {
                    "title": own_path.name,
                    "author": "User supplied",
                    "license": "User supplied; verify your own rights",
                    "license_url": "",
                    "page_url": "",
                    "url": "",
                    "source": "User upload",
                })
                source_records.append(selected[1])

            if selected is None:
                selected = create_fallback_visual_asset(scene_text, work_dir, idx + 1)
                source_records.append(selected[1])
                print("[visual-search] no relevant photo; using scene title card:", idx + 1, scene_text[:140])

            scene_assets.append([selected])
            progress = 34 + int(32 * (idx + 1) / max(1, len(groups)))
            update_job(
                job_id,
                progress=progress,
                message="Sahne görselleri doğrulanıyor… (" + str(idx + 1) + "/" + str(len(groups)) + ")",
            )

        clips = []
        for idx, group in enumerate(groups):
            scene_start = float(group.get("start", 0.0))
            scene_duration = max(0.08, float(group.get("end", scene_start + 0.5)) - scene_start)
            if idx == len(groups) - 1:
                scene_duration = max(0.08, duration - scene_start)
            canvas_path = work_dir / ("scene-" + str(idx + 1) + ".jpg")
            clip_path = work_dir / ("clip-" + str(idx + 1) + ".mp4")
            create_visual_canvas(group, scene_assets[idx], idx, canvas_path, title, hook)
            render_one_scene(canvas_path, scene_duration, clip_path, cleaned_audio, scene_start)
            clips.append(clip_path)
            update_job(
                job_id,
                progress=68 + int(18 * (idx + 1) / max(1, len(groups))),
                message="Hareketli sahneler hazırlanıyor… (" + str(idx + 1) + "/" + str(len(groups)) + ")",
            )

        list_file = work_dir / "clips.txt"
        list_file.write_text("".join("file '" + str(p) + "'\n" for p in clips), encoding="utf-8")
        output_video = work_dir / "shorts.mp4"
        subtitle_file = work_dir / "captions.ass"
        write_ass_subtitles(groups, subtitle_file)
        subtitle_filter_path = str(subtitle_file).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        subtitle_video_filter = (
            "scale=1080:1920:flags=lanczos,setsar=1,subtitles='"
            + subtitle_filter_path + "'"
        )
        update_job(job_id, progress=90, message="Ses, hareketli görüntüler ve zaman kodlu altyazılar birleştiriliyor…")
        final_result = run_command([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
            "-i", str(cleaned_audio), "-map", "0:v:0", "-map", "1:a:0",
            "-t", str(duration), "-vf", subtitle_video_filter,
            "-r", "25", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-threads", os.getenv("FFMPEG_THREADS", "2"),
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart", str(output_video)
        ], timeout=900)
        if final_result.returncode != 0 or not output_video.exists():
            raise RuntimeError("Altyazılı MP4 birleştirme başarısız: " + final_result.stderr[-1600:])

        rendered_duration = probe_duration(output_video)
        duration_delta = abs(rendered_duration - duration)
        if duration_delta > 0.60:
            raise RuntimeError(
                "Kurgu kalite kontrolü: görüntü ve ses süresi uyuşmuyor "
                + str(round(rendered_duration, 2)) + "s / " + str(round(duration, 2)) + "s."
            )

        credits = [
            "CONTENT FACTORY — KAYNAK VE LİSANS KAYDI",
            "Video başlığı: " + title,
            "Süre: " + str(round(duration, 2)) + " saniye",
            "Temizlenen sessizlik: " + str(round(removed, 2)) + " saniye",
            "Kurgu ajanı: " + str(edit_report.get("strategy", "unknown")),
            "Kurgu kesme sayısı: " + str(len(edit_report.get("cuts", []))),
            "Sahne/altyazı sayısı: " + str(len(groups)),
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
                    "  Görsel adresi: " + (item.get("url") or ""),
                    "  Kaynak sayfası: " + (item.get("page_url") or ""),
                    "",
                ])
        else:
            credits.append("Bu render sırasında harici görsel kaynağı kullanılamadı.")
        credits.extend([
            "",
            "Ses motoru: MOSS-TTS-Nano (ONNX CPU). Model ve tokenizer lisans/atıf bilgileri için:",
            "https://github.com/OpenMOSS/MOSS-TTS-Nano",
            "https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX",
            "https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX",
            "",
            "Not: Görseller çok kaynaklı araştırma motoruyla aranır. İnternette bulunması tek başına yeniden kullanım izni vermez. Yayından önce ilgili kaynağın güncel koşullarını doğrulayın.",
        ])
        (work_dir / "sources-and-licenses.txt").write_text("\n".join(credits), encoding="utf-8")
        update_job(
            job_id, status="completed", progress=100, message="Otomatik kurgu tamamlandı; Shorts MP4 hazır.",
            duration=round(rendered_duration, 2), removed_silence=round(removed, 2),
            edit_cut_count=len(edit_report.get("cuts", [])),
            scene_count=len(clips), source_count=len(source_records),
            caption_count=sum(1 for g in groups if str(g.get("text", "")).strip()),
            qc_duration_delta=round(duration_delta, 3),
            edit_strategy=edit_report.get("strategy", "unknown"),
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
