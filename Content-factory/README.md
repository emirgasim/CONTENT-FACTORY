# Content Factory — iPhone-first starter

A GitHub-ready Cloudflare Pages starter for a topic-driven Shorts + long-form video workflow.

## What this version actually does
- Responsive Turkish control panel.
- Creates Shorts series/projects and long-video projects.
- Stores project metadata locally in the browser and exports/imports JSON project files.
- Lets you select a local video/audio file and inspect browser-readable metadata without uploading it to GitHub.
- Builds an editable scene/timeline plan with presenter, stock footage, split-screen, picture-in-picture, collage, infographic and kinetic-text scene types.
- Exports an edit decision list (EDL) as JSON for a future render worker.
- Includes a Cloudflare Pages health endpoint.

## What it does NOT do yet
This starter does **not** automatically research the web, download stock footage, transcribe Turkish speech, remove filler/silence, or render a finished MP4. Those require separate services and real-device testing. The UI deliberately does not pretend these functions are complete.

## Why no R2 / no raw video in GitHub
Raw camera footage is never committed to Git. GitHub is used for source code and small project files only. A 15-minute iPhone video remains on the phone until a processing path is configured.

A static Pages deployment cannot safely receive and process arbitrary multi-GB video by itself. Do not route large video through a normal Pages Function request. The next production phase should use one of:
1. Local processing on a Mac/PC with FFmpeg (most reliable and no cloud media storage), with the phone transferring the file to that machine.
2. A separately hosted, authenticated processing worker with temporary disk and resumable upload.
3. A tested on-device browser processing pipeline, only after iPhone Safari memory/codec/performance tests.

For an iPhone-only workflow, option 2 is the likely practical route, but it needs a compute host and temporary storage. This repository intentionally does not claim GitHub is a video-processing server.

## Deploy to Cloudflare Pages from GitHub
1. Create a **private** GitHub repository named `content-factory` under your `emirgasim` account.
2. Upload the contents of this folder to the repository root (not the parent folder).
3. In Cloudflare Dashboard, open Workers & Pages → Create → Pages → Connect to Git.
4. Select `content-factory`.
5. Framework preset: `None`.
6. Build command: leave empty.
7. Build output directory: `public`.
8. Deploy.

No API keys are required for this starter. Do not add secrets until a specific integration is implemented.

## Local preview
Open `public/index.html` in a browser, or serve `public` with any static web server.

## Project model
Projects are format-agnostic. Each project has:
- format: `shorts` or `long`
- topic/series and subtopics
- narration/script text
- local media metadata (not media bytes)
- scenes with timing, layout and visual source notes
- edit decisions and export settings

## Next production milestones
- M1: Connect a verified stock-media search provider and record license/source metadata.
- M2: Add speech-to-text with word/segment timestamps; benchmark Turkish.
- M3: Implement silence/repetition detection with human approval before destructive cuts.
- M4: Implement the render engine using FFmpeg and an authenticated resumable upload path.
- M5: Test 15-minute iPhone MOV/HEVC footage, interrupted upload resume, audio sync, split-screen and final CapCut import.
