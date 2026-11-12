# Content Factory — Single-topic Shorts workflow

Konu araştırması ve seslendirme metni GPT sohbetinde hazırlanır. Panel her seferinde tek konu ve tek hazır ses dosyası alır.

## Shorts flow
1. GPT sohbetinde konu araştırmasını ve seslendirme metnini hazırla.
2. Panelde Shorts Factory → yeni konu.
3. İsteğe bağlı konu başlığını gir, seslendirme metnini yapıştır.
4. O konuya ait MP3/WAV dosyasını yükle.
5. Sessizlik temizleme eşiğini, minimum duraklamayı ve korunacak payı ayarla.
6. Önizlemeyi dinle; temizlenmiş WAV'ı ve konu JSON'unu indir.
7. "Yeni konuya geç" ile ikinci konuya geç. İki videoyu son aşamada CapCut'ta birleştir.

## Audio silence trimming
- Decodes supported audio files locally with Web Audio API.
- Measures 20ms RMS windows and groups speech-active ranges.
- Removes gaps longer than the selected minimum pause, retaining configurable audio padding around speech.
- Exports a 16-bit PCM WAV file.
- Does not upload audio to GitHub, Cloudflare R2, or any remote endpoint.
- Breath sounds can overlap speech and cannot be reliably identified as breaths using simple silence detection. Low-level breaths may be trimmed depending on threshold. Always listen to the preview before using the result.
- Browser/iOS codec and memory support varies. If an audio file cannot be decoded on iPhone, export WAV from ElevenLabs or use another supported format.
- Audio bytes are only held in the current browser session; project metadata and narration text are saved locally. Re-select the audio file after refreshing the page.

## Long-video route
This build keeps the long-video entry as a preparation placeholder. Large file transfer, transcript timing, automatic edit decisions and final MP4 rendering are not implemented yet.

## Cloudflare Pages
Repository subdirectory: Content-factory/
- Root directory: Content-factory
- Framework: None
- Build command: empty
- Build output directory: public

Raw camera footage must never be committed to GitHub.