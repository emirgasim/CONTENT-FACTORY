# Content Factory

iPhone-first Shorts production workspace. The Shorts Factory renders directly in iPhone Safari using browser-native audio, Canvas and MediaRecorder APIs. No Claude, paid API, render server, account token or per-video credits are required for local rendering.

## iPhone Shorts workflow

1. Open the site in Safari on the iPhone.
2. Paste the narration text and enter a topic title.
3. Record narration with the microphone or select an MP3, M4A or WAV file.
4. Optionally select up to eight images from Photos / Files. If none are selected, the renderer creates animated graphic scenes itself.
5. Tap iPhone'da Shorts üret.
6. The browser decodes the audio locally, detects long low-volume gaps, keeps short natural pauses and joins the remaining audio.
7. The script is divided into visual beats and distributed over the cleaned audio duration. The renderer animates 9:16 Canvas scenes and records the Canvas plus cleaned audio to MP4 using Safari MediaRecorder.
8. Preview and save the MP4, cleaned WAV and render notes.

## Local rendering architecture

- public/local-render.js: browser-only audio analysis, silence edit decision list, scene planning, Canvas animation, audio mixing, MP4 recording and local downloads.
- public/app.js: UI, microphone capture, file selection and state.
- public/index.html: iPhone-first interface.
- Cloudflare Pages serves static files only. It does not process the audio or video.
- No audio, script or selected image is uploaded to a render service by the Shorts Factory local render path.
- MP4 output is feature-detected. Safari must report video/mp4 MediaRecorder support; the app will not silently rename a WebM file to MP4.
- Default output: 1080 × 1920, 24 fps. A 720 × 1280 option is available for lower-memory devices.
- The initial local renderer accepts audio up to 3 minutes and up to 8 optional user images.

## Current capability boundaries

- Silence detection is waveform/RMS based. It shortens long low-volume gaps while retaining a small amount of room tone. Very quiet speech may be mistaken for silence; always review the result.
- Script timing is currently distributed over the cleaned audio using word-count weights. This is approximate timing, not local Whisper transcription or exact word-level forced alignment.
- Visuals are original animated graphic compositions and optional images selected by the user. This initial iPhone-only build does not automatically download stock footage or search Wikimedia; no external stock API or media service is called.
- The renderer does not yet generate a natural-language visual storyboard from an LLM. It uses deterministic scene layouts based on the script text.
- iPhone Safari must remain open in the foreground during rendering. Screen Wake Lock is requested where supported, but iOS may still interrupt long tasks or background tabs.
- Browser memory, battery, thermal throttling and hardware encoder availability limit practical render length and quality. No credits does not mean unlimited device resources.
- MP4 generation must be tested on the user's exact iPhone/Safari version before treating the workflow as production-ready.

## Agent Hub

The YouTube Agent Hub remains a separate set of in-panel deterministic analysis tools and ChatGPT task briefs. It is not required by the local Shorts renderer.

## Security and privacy

- GitHub stores source code only.
- Audio, script and optional images are processed in the browser memory and are not committed to GitHub or sent to a remote render API by the local renderer.
- The page must be served over HTTPS for microphone access.