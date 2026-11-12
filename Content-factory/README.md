# Content Factory — iPhone Shorts Factory

The Shorts Factory produces vertical MP4 directly in iPhone Safari. No render server, paid API key, per-video credit or Claude dependency is used by the local rendering path.

## Production flow

1. Enter the topic, a required manual hook, the narration text and matching audio.
2. Optionally add up to eight of your own image references.
3. The browser analyzes the complete audio waveform conservatively. It preserves the original recording if silence removal would remove more than 7% or 3.5 seconds.
4. The script is split into visual beats. The renderer searches Wikimedia Commons per scene, prioritizing the topic title and adding Turkish-to-English keyword aliases.
5. Only CC0, public-domain, CC BY and CC BY-SA images are selected; NC and ND files are rejected. Each scene tries multiple search queries and avoids reusing the same image URL within one render.
6. Each scene has a randomly selected, vivid solid color palette with opaque cartoon-style geometric animation. Gradients are not used.
7. The central visual remains in a consistent square frame. The manual hook appears in a banner at the top. Captions have no outline; light caption plates use black text and saturated plates use white text.
8. A duration bar uses the audio playback clock and reaches 100% only on the final audio frame. MP4 metadata is checked against the full cleaned narration duration before the file is shown as complete.
9. Preview and save the MP4, cleaned WAV and source/license report.

## Source and license handling

- Commons is queried through its public MediaWiki Action API with CORS, image information, thumbnails and extended license metadata. Search results are paginated (50 per API page); there is no fixed 8-image or fixed per-video image limit. The target is calculated from narration duration, at roughly one distinct visual every 2.5 seconds, separately for each scene. Search continues through API pages and query variants until that target is met or the source has no more eligible results.
- CC0, Public Domain, CC BY and CC BY-SA are accepted. NonCommercial and NoDerivatives variants are excluded.
- Each selected file's author, license, license URL and Commons file page are written to the source/license report. The renderer cycles through the scene's collected images at the same 2.5-second visual cadence.
- Wikimedia Commons licensing guidance: https://commons.wikimedia.org/wiki/Commons:Licensing
- CC BY and CC BY-SA require attribution. CC BY-SA includes a share-alike condition; follow each selected file's specific terms.
- Stock-image matching depends on the public Commons search index and available license metadata. If an eligible image cannot be found or fetched, the renderer records the fallback and uses original graphic art rather than claiming an image was found.

## Optional desktop-only Python stock-library prototype

The separate Python prototype uses `requests`, `beautifulsoup4`, `pillow` and `playwright`. Its setup commands are `pip install requests beautifulsoup4 pillow playwright` and `playwright install chromium`. These commands run on a computer with Python, not inside iPhone Safari. They are not required by the iPhone-only Shorts Factory, which performs its stock-image search and rendering in the browser. The prototype's Bing HTML scraping does not establish image reuse rights; do not treat a Bing result as licensed unless the original source's license is independently verified.

## iPhone render constraints

- Output: 1080 × 1920 at 24 fps by default, with a 720 × 1280 lower-memory option.
- Browser must report MediaRecorder MP4 support; the app does not rename WebM to MP4.
- Keep Safari in the foreground. iOS may suspend background tabs and media work.
- Browser memory, battery, thermal throttling and hardware encoder limits still apply. No credits means no per-video billing, not unlimited device resources.
- Script-to-audio scene timing is approximate, distributed by word count. This build does not perform word-level forced alignment or local speech recognition.

## Privacy

- Script, audio and user-selected images remain in browser memory for local rendering.
- Commons requests send scene/topic search terms, not narration audio.
- GitHub stores source code only; do not commit audio, generated videos or secrets.