# Content Factory

iPhone-first Shorts / long-form workflow. GPT sohbeti konu araştırması ve senaryoyu hazırlar; Content Factory tek bir Shorts konusunun sesini ve görsel MP4 çıktısını yönetir.

## Current Shorts workflow

1. GPT sohbetinde konuyu ve 40–45 saniyelik ElevenLabs/MOSS uyumlu seslendirme metnini hazırla.
2. Panelde **Shorts Factory** aç; yalnızca tek konunun metnini yapıştır.
3. Kendi sesinden 10–30 saniyelik temiz referans kaydını bir kez yükle. Dosya cihazın IndexedDB alanında saklanır.
4. **Seslendirme örneği oluştur** ile MOSS-TTS-Nano ses önizlemesini üret ve dinle.
5. Beğenince **Sesi onayla ve videoyu hazırla** düğmesine bas.
6. Engine uzun sessizlikleri kısaltır, Türkçe konuşmayı zaman kodlarına ayırır, Wikimedia Commons'tan uygun lisanslı görseller arar ve 9:16 MP4 render eder.
7. MP4, temizlenmiş WAV ve kaynak/lisans dökümünü indir.
8. İkinci konu için yeni Shorts başlat; iki sonucu CapCut'ta kendi kamera kliplerinle birleştir.

## Architecture

- GitHub: source code and documentation.
- Cloudflare Pages: static iPhone-friendly website.
- `voice-engine/`: separate Python Docker service that runs MOSS-TTS-Nano ONNX, FFmpeg, Whisper transcription, Wikimedia Commons media search and MP4 rendering.
- Raw recordings and generated files are not committed to GitHub and are not stored in R2 by this frontend.

The Python media engine cannot run inside Cloudflare Pages. Deploy `voice-engine/` as a separate Docker service (for example a Hugging Face Docker Space) or run it on a suitable computer. The website requires its URL and shared token under **Motor ayarı**.

## Voice engine deployment

See [voice-engine/README.md](voice-engine/README.md). The uploaded MOSS source ZIP contains source code, not model weights. The Docker image downloads the official ONNX TTS and audio-tokenizer weights on first startup from Hugging Face.

## Implemented frontend

- One-topic-at-a-time workflow.
- Text paste field and optional topic title.
- Local reference voice profile stored in IndexedDB.
- MOSS TTS preview request and playback.
- User approval gate before trimming/rendering.
- Render job status polling.
- MP4, cleaned WAV and attribution download controls.
- Engine URL and token configuration.

## Engine behavior and limits

- TTS uses MOSS-TTS-Nano ONNX CPU voice cloning.
- Silence trimming uses FFmpeg's `silenceremove` filter. It trims long low-level gaps; it does not semantically identify breaths. Very quiet breaths may be shortened, so preview the final audio.
- Speech timestamps are generated with Whisper segment-level timestamps, not exact forced word alignment.
- The first renderer searches still images on Wikimedia Commons and filters known CC0, Public Domain, CC BY and CC BY-SA licenses. It creates animated zoom/pan, split layouts, collage and bright infographic cards, then writes source/license credits.
- Video stock footage search, sophisticated word-level alignment, face-camera compositing and cinematic fine-grained editing are future improvements.
- Output is 1080×1920, 25 fps, H.264/AAC. Actual MP4 duration follows the cleaned audio; spoken content is not cut merely to force 40–45 seconds.
- The media engine is CPU intensive. Free model weights do not mean unlimited or zero-cost compute.

## Cloudflare Pages settings

Repository subfolder: `Content-factory/`
- Root directory: `Content-factory`
- Framework preset: `None`
- Build command: empty
- Build output directory: `public`

## Privacy and security

- Set a long random `FACTORY_API_TOKEN` on the engine and paste the same token into the website's Motor ayarı.
- Restrict `ALLOWED_ORIGINS` to the production Pages origin.
- Use only a voice you own or are authorized to clone.
- Rendered jobs are temporary and held by the engine process; they are not long-term cloud storage.
