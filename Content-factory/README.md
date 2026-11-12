# Content Factory

iPhone-first Shorts workflow. GPT sohbeti konu araştırmasını ve 40–45 saniyelik seslendirme metnini hazırlar. Kullanıcı metni panelde yapıştırır, iPhone mikrofonuyla doğrudan anlatımı kaydeder, kaydı dinleyip onaylar ve video render işini başlatır.

## Current Shorts workflow

1. GPT sohbetinde tek konu için yaklaşık 40–45 saniyelik metni hazırla.
2. Panelde **Shorts Factory** aç ve metni yapıştır.
3. **Kayda başla** ile iPhone mikrofonundan metni oku; **Kaydı bitir** ile durdur.
4. Kaydı sayfa içindeki oynatıcıdan dinle. Gerekirse yeniden kaydet.
5. **Kaydımı dinle** önizlemesini aç ve **Sesi onayla ve videoyu hazırla** düğmesine bas.
6. Kayıt doğrudan render motoruna gönderilir. Motor uzun sessizlikleri azaltır, konuşmayı analiz eder, görsel sahneler hazırlar ve 9:16 MP4 üretir.
7. MP4 ve varsa temizlenmiş ses/kaynak dökümünü indir.
8. İkinci konu için yeni Shorts başlat; CapCut'ta kendi yüz kliplerinle birleştir.

## Microphone recording

- Uses browser `getUserMedia({audio})` and `MediaRecorder`; no file picker or separate audio upload is needed.
- Requires HTTPS and explicit microphone permission. On iPhone, use Safari and allow microphone access when prompted.
- Supported recording MIME type is selected from audio/mp4 or WebM variants exposed by the browser. Actual support varies by iOS/Safari version.
- The recorded narration is held in page memory and sent to the configured render engine only after user approval. It is not stored in GitHub or localStorage.
- Refreshing or closing the page discards the unsent recording. Keep the page open until render has completed.
- The user is recording the actual narration; this workflow does not synthesize cloned speech or need a reference audio upload.

## Architecture and deployment

- GitHub stores source code only.
- Cloudflare Pages hosts the static web UI.
- Python engine in `voice-engine/` must run separately and be reachable over HTTPS. It cannot run inside Cloudflare Pages.
- Website → **Motor ayarı**: enter engine URL and the same `FACTORY_API_TOKEN` configured on the engine.
- The frontend expects:
  - `GET /health`
  - `POST /api/shorts/render` multipart fields `text`, `title`, `audio`
  - `GET /api/jobs/{job_id}`
  - `GET /api/jobs/{job_id}/video`
  - `GET /api/jobs/{job_id}/audio`
  - `GET /api/jobs/{job_id}/credits`

## Rendering capabilities and honest limits

The Python render engine is a separate deployment requirement. A GitHub commit or Cloudflare Pages deployment does not itself start this engine. Configure a reachable engine before expecting MP4 output.

The documented first renderer trims low-volume pauses, transcribes speech with Whisper segment timestamps, searches Wikimedia Commons still images and creates a 1080×1920 MP4 with animated zoom/pan, split layouts, collage and colorful infographic cards. It does not yet search video stock footage, guarantee exact word-level synchronization, or composite the user's face camera footage. It must not be described as a finished full stock-video director until those features are built and tested.

The rendered duration follows the cleaned narration; spoken words are not cut just to force 40–45 seconds. Preview the cleaned result because quiet breaths can be shortened by silence detection.

## Cloudflare Pages settings

- Root directory: `Content-factory`
- Framework preset: None
- Build command: empty
- Build output directory: `public`

## Security and privacy

- Set a long random `FACTORY_API_TOKEN` on the engine and paste the same token into Motor ayarı.
- Restrict `ALLOWED_ORIGINS` to the production Pages origin.
- Only record and use your own voice or a voice you are authorized to use.
- Do not commit recordings, generated media or secrets to GitHub.
