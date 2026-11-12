# Content Factory

GPT sohbetini içerik araştırma ve senaryo merkezi; bu paneli ise medya kabulü ve üretim masası olarak kullanan iPhone-first Shorts / long-form workflow.

## GPT-first Shorts workflow

1. GPT sohbetinde seri, Part ve aynı kategoride tam iki konu hazırlanır.
2. Her konu için ElevenLabs'e hazır seslendirme metni, görsel/sahne planı, stok kaynak ve lisans notları hazırlanır.
3. GPT sohbetinden `content-factory-shorts-v1` JSON paketi indirilir.
4. Panelde Shorts Factory açılır → **GPT paketini içe aktar**.
5. Her konu için MP3/WAV yüklenir. Alternatif olarak ses içeren video seçilerek tarayıcı destekliyorsa MediaRecorder/captureStream ile ses yakalama denenir.
6. İki konu ve ses meta verileri ayrı tutulur; üretim paketi JSON olarak dışa aktarılabilir.

### Shorts package schema

```json
{
  "schema": "content-factory-shorts-v1",
  "projectName": "Series — Part 1",
  "series": "Series title",
  "part": "Part 1",
  "description": "Short description",
  "topics": [
    {
      "title": "Topic A",
      "script": "ElevenLabs-ready narration",
      "duration": "40–45 seconds",
      "scenes": [
        {
          "start": "00:00",
          "end": "00:05",
          "layout": "Full-screen presenter",
          "visual": "Visual description",
          "source": "Source URL or asset description",
          "license": "License / reuse notes"
        }
      ]
    },
    {
      "title": "Topic B",
      "script": "Second narration",
      "duration": "40–45 seconds",
      "scenes": []
    }
  ]
}
```

Download the schema template from inside Shorts Factory. The package must contain exactly two topics.

## Audio handling limitations

- Uploaded audio/video files remain on the user's device; they are not committed to GitHub and are not uploaded to a cloud media bucket by this frontend.
- Audio file selection is supported. File metadata is kept in the local project state; browser file bytes are not persisted in localStorage.
- Video-to-audio extraction uses browser `HTMLMediaElement.captureStream` / `MediaRecorder` when available. Support varies by browser and iOS version; the panel shows a fallback instruction if unsupported. For dependable iPhone fallback, extract audio in CapCut and upload MP3/WAV.
- Do not assume this frontend can transcribe audio, fetch stock footage, or render MP4.

## Long video

The long-video route accepts a GPT long-form JSON package and lets the user select a local MP4/MOV for metadata inspection. It does not upload or process the large file yet.

## Current implementation status

Implemented:
- Mobile responsive panel.
- GPT-first Shorts package import and validation.
- Two topic cards, separate script display/copy and topic JSON export.
- Per-topic MP3/WAV selection.
- Best-effort browser video-audio extraction where supported.
- JSON export and local project metadata.
- Long-video package import and local video metadata selection.

Not implemented yet:
- ChatGPT-to-Cloudflare automatic synchronization.
- Speech-to-text and word-level timestamps.
- Stock footage search/download and automated license verification.
- Automatic scene selection from transcript.
- FFmpeg render service / MP4 export.
- Resumable large-file upload and remote processing.

These require separate, tested integrations. No OpenAI/Gemini API key is used by this static frontend.

## Cloudflare Pages

GitHub repository path: `Content-factory/`

Pages build settings:
- Root directory: `Content-factory`
- Framework preset: `None`
- Build command: empty
- Build output directory: `public`

Raw camera footage must never be committed to GitHub.
