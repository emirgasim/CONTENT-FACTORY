# Content Factory

iPhone-first creator workflow. GPT sohbeti konu araştırması ve seslendirme metnini hazırlar; panel bir Shorts konusunu tek seferde alır ve ses dosyasını yerel tarayıcıda işler.

## Shorts: one topic at a time

1. Konu araştırması ve seslendirme metni ChatGPT sohbetinde hazırlanır.
2. Panelde **Shorts Factory** açılır.
3. İsteğe bağlı konu başlığı ve seslendirme metni yapıştırılır.
4. ElevenLabs MP3/WAV/M4A dosyası seçilir.
5. **Duraklamaları analiz et ve kırp** ile uzun düşük sesli/sessiz aralıklar tespit edilir.
6. Temizlenmiş WAV dinlenir ve indirilir.
7. Kullanıcı ikinci konu için yeni işlem açar; iki video CapCut'ta birleştirilir.

## Local silence trimming

- Audio bytes are read with the browser File API and decoded using Web Audio API.
- 10 ms RMS windows identify low-level sections using an adjustable dB threshold.
- Only quiet gaps longer than the selected minimum duration are shortened; configurable audio padding is retained around cuts.
- Output is an uncompressed PCM WAV created locally in the browser. Original file is not modified or uploaded.
- The user should preview the result before using it. Quiet breaths may be shortened if they fall below the selected threshold for long enough; this is not semantic breath recognition or studio-grade noise editing.
- iOS Safari decoding support depends on the source codec and available device memory. If a file cannot decode, convert/export it as WAV or MP3 in an audio app and retry.
- Processing happens in device memory. Very long/high-resolution audio can require substantial memory.

## Current limitations

This feature does not yet:
- generate the narration or call ElevenLabs;
- identify breaths separately from silence;
- perform speech recognition or word-level alignment;
- search/download stock footage;
- create a synchronized video or render MP4;
- upload large camera footage to a remote processor.

The long-form workspace remains a separate future implementation. No raw media is committed to GitHub or uploaded to R2 by this static frontend.

## Cloudflare Pages

Repository folder: `Content-factory/`
- Root directory: `Content-factory`
- Framework preset: `None`
- Build command: empty
- Build output directory: `public`
