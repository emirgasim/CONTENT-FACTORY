# Content Factory — Cloud Shorts Factory

Shorts rendering runs on a temporary GitHub-hosted Linux runner, not in iPhone Safari. The iPhone is used only to upload inputs, view progress, preview the finished MP4 and download it. The render worker uses FFmpeg and local Python packages; no paid video-generation API is called.

## Background workflow

1. From iPhone Safari, submit the mandatory hook and a narration audio file. The cleaned narration must be 40–45 seconds; out-of-range audio is rejected before image review rather than cut or time-stretched.
2. Cloudflare Pages stores the audio and job metadata in the private `SHORTS_TEMP` Workers KV namespace and dispatches the `shorts-background.yml` workflow in `research` phase.
3. The temporary GitHub-hosted Linux runner transcribes the audio, creates word-aligned visual beats with a 2.8-second maximum, researches real-photo candidates from open/licensed sources, and uses CLIP to rank for scene relevance while explicitly down-ranking illustrations, paintings, sketches, CGI, 3D renders and synthetic imagery. For a 40–45 second narration this normally produces about 15–16 image scenes. It uploads candidate previews and a review manifest, then stops at `awaiting_approval`; it does not render.
4. The user reviews each scene and selects one candidate. The authenticated approval endpoint stores the exact selected candidate IDs and dispatches the workflow in `render` phase. No render is allowed until every scene has a valid approved image.
5. The render worker downloads those exact selected images, re-creates the same audio timeline and passes the approved image list to the renderer. It uploads the MP4, cleaned WAV and source/credits report to KV.
6. The user downloads the MP4 and presses `İndirdim, projeyi sil` to delete the entire job prefix immediately. KV keys have a 24-hour expiry as a fallback.

## One-time Cloudflare setup

1. In Cloudflare Pages, confirm the Workers KV namespace ID in `wrangler.toml` is the intended namespace and the binding name is exactly `SHORTS_TEMP` for Production (and Preview only if testing previews).
2. In Pages Settings → Variables and Secrets, add `GITHUB_ACTIONS_TOKEN` (GitHub fine-grained token restricted to this repository with Actions: Read and write), `CF_WORKER_SECRET` (a long random shared secret), and `CONTENT_FACTORY_URL` (the deployed Pages origin, for example `https://your-project.pages.dev`). The GitHub token and worker secret are server-side only and must never be sent to the browser.
3. Add the same `CF_WORKER_SECRET` and `CONTENT_FACTORY_URL` values as GitHub Actions repository secrets. The workflow worker uses them to authenticate to Pages internal routes.
4. Redeploy the Pages project after setting bindings and secrets.

## One-time GitHub setup

In repository Settings → Secrets and variables → Actions, add these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `R2_ACCESS_KEY_ID` — R2 S3 API token access key ID.
- `R2_SECRET_ACCESS_KEY` — R2 S3 API token secret access key.

Add this repository Actions variable (optional; this is also the default bucket name):

- `R2_BUCKET_NAME` = `content-factory-short-jobs`.

Create an R2 API token with object read/write access limited to this bucket. Do not put the R2 secret key or GitHub dispatch token in frontend JavaScript, HTML or Git.

## Temporary storage and cleanup

- Project objects are stored under `jobs/{job_id}/` in the private `SHORTS_TEMP` Workers KV namespace: input audio, hook metadata, candidate images, review manifest, approved selections, status, MP4, cleaned WAV and source report.
- Each project has a random per-job owner token. Status, download and delete routes require this token.
- After the user downloads the MP4 and confirms, the Pages Function deletes every object under that job prefix.
- Every KV object is written with a 24-hour TTL. Unconfirmed projects therefore expire automatically without relying on a scheduled R2 cleanup task.
- KV object expiration is the fallback cleanup. Manual deletion removes the full project prefix immediately.
- The `SHORTS_TEMP` KV namespace is private to Pages Functions. Do not expose the worker secret or job owner tokens. All job keys are prefixed by a random job ID and expire after 24 hours.

## Render environment

- GitHub-hosted `ubuntu-latest` runner, FFmpeg, Python 3.12, Pillow, Requests, faster-whisper, CPU PyTorch and Transformers/CLIP.
- Whisper model weights are cached between compatible workflow runs where possible.
- One render job has a 90-minute workflow timeout. The number and duration of jobs are subject to the GitHub Actions plan's included runner minutes and concurrency limits.
- Workers KV and GitHub Actions usage are subject to their respective plan quotas and runner-minute limits. Immediate delete-after-download plus 24-hour expiry minimizes retained media but does not make compute/storage unlimited.
- No media files are committed to GitHub. Audio, candidate images and output files are held in private KV and ephemeral runner storage.

## Open image sources

The Python render engine searches Wikimedia Commons, Openverse and Library of Congress public collections without a paid provider key. It selects records only when metadata states a reuse-friendly license/rights status, records the author, source page and license, and uses original graphics if no suitable file can be fetched. Publicly viewable images are not automatically free to reuse; review the generated sources-and-licenses report and each file's actual terms.

## Troubleshooting

- If job submission says R2 is not bound, verify Pages binding `SHORTS_JOBS` and redeploy.
- If job submission says the background worker cannot start, check the Pages secret `GITHUB_ACTIONS_TOKEN` and repository Actions permission.
- If workflow starts but reports R2 auth failure, check `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME`.
- If iPhone Safari is closed, the GitHub-hosted runner continues. Reopen the site in the same browser profile to resume using the saved job token.
- If the user does not download and confirm, the scheduled 24-hour expiry cleanup is the fallback.

## 40–45 second photo-review profile

- The cleaned narration is accepted only when its duration is between 40.0 and 45.0 seconds. The system never cuts spoken words or time-stretches speech to force the target.
- Visual beats use the shared word-aligned planner (`max_words=7`, `max_seconds=2.8`) in both research and render phases so scene IDs and timestamps remain stable.
- The review screen presents the scene text, time range, photo alternatives, provider, license and source-page link. One photo must be selected for every scene before the render workflow is dispatched.
- If no verified candidate exists for a scene, research fails closed and asks for a retry; it does not silently substitute an unrelated graphic or generated image.
