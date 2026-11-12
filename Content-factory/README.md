# Content Factory — iPhone Shorts Factory

The Shorts Factory produces vertical MP4 directly in iPhone Safari. No render server, paid API key, per-video credit or Claude dependency is used by the local rendering path.

## Production flow

1. Paste narration text and select/record the matching audio.
2. Optionally add up to eight of your own visual reference images.
3. The browser analyzes the complete audio waveform. Long low-volume pauses may be removed conservatively; if estimated cuts exceed 7% of the recording, the entire original audio is preserved to avoid cutting speech.
4. The script is split into short visual beats. For every beat, the renderer searches Wikimedia Commons for image files and reads each file's license metadata.
5. Only CC0, public-domain, CC BY and CC BY-SA results are selected. NC and ND files are rejected. If no suitable image loads, the scene uses original graphic/pixel artwork.
6. Each scene is placed in a centered square visual frame with a unique, randomly generated bright background composition. Layout, colors, shapes and motion vary per render and per scene.
7. Canvas animation and cleaned narration are recorded locally through Safari MediaRecorder as MP4. The resulting video metadata is checked against expected audio duration before download is enabled.

## Source and license handling

- Commons is queried through its public MediaWiki Action API with CORS (origin=*), image information and extended license metadata.
- Each selected file's author, license, license URL and Commons file page are written to sources-and-licenses.txt.
- Wikimedia Commons licensing guidance: https://commons.wikimedia.org/wiki/Commons:Licensing
- CC BY and CC BY-SA permit commercial reuse subject to attribution; BY-SA has share-alike requirements. The user must follow each file's specific license and check any non-copyright restrictions.
- Internet image search depends on network availability. If Commons is unavailable or no eligible image loads, the renderer uses original graphics and records that fallback; it does not silently use unlicensed images.

## iPhone render constraints

- Output: 1080 × 1920 at 24 fps by default, with a 720 × 1280 lower-memory option.
- The browser checks for MediaRecorder MP4 support before starting. It does not rename WebM to MP4.
- Keep Safari in the foreground while rendering. iOS can suspend background tabs and browser media tasks.
- The app checks the actual generated MP4 duration against the cleaned narration duration. Incomplete output is rejected instead of presented as finished.
- Browser memory, device temperature, battery and Safari's hardware encoder remain practical limits. No credits means no per-video billing, not unlimited device processing.
- Text-to-audio timing is currently distributed over the cleaned narration based on word count. It is not word-level forced alignment or on-device speech recognition.

## Agent Hub

The separate YouTube Agent Hub remains a set of deterministic in-panel analysis tools and ChatGPT task briefs. It is not required for video rendering.

## Privacy

- Scripts, selected audio and personal images remain in browser memory for the local render path.
- Commons image searches send the scene's extracted topic/search words to Wikimedia Commons, not the audio file.
- GitHub stores application source code only; never commit audio, generated videos or secrets.