---
title: Content Factory Voice Engine
emoji: 🎬
colorFrom: yellow
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: apache-2.0
---

# Content Factory Voice & Video Engine

CPU-first MOSS-TTS-Nano ONNX voice cloning + pause trimming + short-form video rendering API.

## What it does

- `POST /api/voice/preview`: generate a complete narration preview using a reference voice recording.
- `POST /api/shorts/render`: after approval, trim long low-volume pauses, transcribe Turkish speech with Whisper, search Wikimedia Commons for license-filtered images and render a 9:16 MP4 with colorful animated graphic layouts.
- `GET /api/jobs/{job_id}`: poll render status.
- `GET /api/jobs/{job_id}/video`: download MP4.
- `GET /api/jobs/{job_id}/audio`: download cleaned WAV.
- `GET /api/jobs/{job_id}/credits`: download source and license credits.
- `GET /health`: service readiness.

## Deploy as a Hugging Face Docker Space

1. Create a new **Docker Space**.
2. Create the Space with a name such as `YOUR_ACCOUNT/content-factory-engine`; choose Docker.
3. In GitHub repository Settings → Secrets and variables → Actions, add `HF_TOKEN` (a Hugging Face write token) and `HF_SPACE_ID` (the exact `owner/space-name`). The included GitHub Action copies this folder to the Space root whenever the engine code changes.
4. Select CPU hardware. The first boot downloads ONNX model and audio-tokenizer weights from the official Hugging Face model repositories.
5. In Space Settings → Variables and secrets, add:
   - `FACTORY_API_TOKEN`: a long random secret used by the Content Factory website.
   - `ALLOWED_ORIGINS`: `https://content-factory-7s6.pages.dev`
   - Optional `CPU_THREADS=2`, `ASR_MODEL_SIZE=base`.
6. Wait for the first build and model warm-up. Test `https://YOUR-SPACE.hf.space/health`.
7. In Content Factory → Motor ayarı, enter the Space URL and the same `FACTORY_API_TOKEN`.

**Hardware and price note:** The model does not charge per character, but it still needs compute. Hugging Face currently lists CPU Basic as 2 vCPU / 16 GB and $0 per running hour; creating a new compute Space requires an eligible paid plan. CPU Upgrade is billed hourly. Check current account eligibility and prices before creating the Space. See https://huggingface.co/docs/hub/spaces-gpus and https://huggingface.co/pricing.

## Local deployment

A machine with Docker and enough RAM can run the same folder. Build and run the Dockerfile, exposing port 7860. Set `FACTORY_API_TOKEN` and `ALLOWED_ORIGINS` before exposing it to the internet.

## Privacy and safety

- Reference audio and generated audio pass through the configured engine. Uploaded reference audio is handled by the upstream MOSS app's temporary upload route; generated job files are stored in the engine's temporary directory.
- Render job files are stored in the container's temporary directory and removed opportunistically when a later job starts after `JOB_TTL_SECONDS` (default two hours), or when the container restarts.
- Set a strong `FACTORY_API_TOKEN`; do not leave a public production engine unauthenticated.
- Only upload a voice recording you own or are explicitly authorized to clone.
- Wikimedia Commons assets are filtered to CC0, public-domain, CC BY and CC BY-SA categories where metadata is available. Each selected file's source and license are written to `sources-and-licenses.txt`. The user should still review the credit file and source page.

## Limitations

- The engine uses Wikimedia Commons still images in this first renderer; video stock footage is not yet searched.
- Visual layouts are selected from the transcript and include full-screen imagery, split layouts, collages and colorful infographic cards. This is an automated first pass, not editorially perfect AI film direction.
- Whisper timestamps are segment-level, not exact forced word alignment.
- The output is 1080×1920, 25 fps, H.264/AAC. Actual duration follows the cleaned voice; the service does not cut spoken words to force a 40–45 second duration.
- Model weights are downloaded at first run; they are not included in GitHub.
