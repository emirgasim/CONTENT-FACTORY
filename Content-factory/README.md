# Content Factory — Cloud Shorts Factory

Shorts rendering runs on a temporary GitHub-hosted Linux runner, not in iPhone Safari. The iPhone is used only to upload inputs, view progress, preview the finished MP4 and download it. The render worker uses FFmpeg and local Python packages; no paid video-generation API is called.

## Background workflow

1. From iPhone Safari, submit the topic title, mandatory hook, narration text, audio file and up to eight optional visual references.
2. Cloudflare Pages Function stores the files in a private Cloudflare R2 bucket and dispatches the `shorts-background.yml` GitHub Actions workflow.
3. A separate GitHub-hosted Linux runner downloads the job from R2, trims pauses, transcribes the narration, searches open image collections and renders the MP4 with FFmpeg.
4. The runner uploads the MP4, cleaned WAV, source/credits report and job status back to the private R2 bucket.
5. The iPhone page polls the R2-backed status endpoint. The user downloads the MP4 and presses `İndirdim, projeyi sil` to delete the entire project prefix immediately.
6. If the user does not confirm deletion, a scheduled cleanup workflow runs every six hours and removes jobs after their 24-hour expiry.

## One-time Cloudflare setup

1. In Cloudflare R2, create a private bucket named `content-factory-short-jobs`.
2. In the Cloudflare Pages project `content-factory`, open Settings → Functions → R2 bucket bindings. Add binding name `SHORTS_JOBS` and select bucket `content-factory-short-jobs`. The same binding is declared in `wrangler.toml`; ensure it is present for Production (and Preview only if testing previews).
3. In Pages Settings → Variables and Secrets, add the production secret `GITHUB_ACTIONS_TOKEN`. Use a GitHub fine-grained token restricted to this repository with Actions: Read and write permission. This token is server-side only and is never sent to the browser.
4. Redeploy the Pages project after adding the R2 binding and secret.

## One-time GitHub setup

In repository Settings → Secrets and variables → Actions, add these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID.
- `R2_ACCESS_KEY_ID` — R2 S3 API token access key ID.
- `R2_SECRET_ACCESS_KEY` — R2 S3 API token secret access key.

Add this repository Actions variable (optional; this is also the default bucket name):

- `R2_BUCKET_NAME` = `content-factory-short-jobs`.

Create an R2 API token with object read/write access limited to this bucket. Do not put the R2 secret key or GitHub dispatch token in frontend JavaScript, HTML or Git.

## Temporary storage and cleanup

- Project objects are stored under `jobs/{job_id}/` in a private R2 bucket: input audio, script/hook metadata, reference images, status, intermediate outputs, final MP4, cleaned WAV and license report.
- Each project has a random per-job owner token. Status, download and delete routes require this token.
- After the user downloads the MP4 and confirms, the Pages Function deletes every object under that job prefix.
- Scheduled fallback cleanup expires unconfirmed projects after 24 hours and runs every six hours; therefore storage cleanup may happen up to approximately six hours after the 24-hour expiry.
- Per-IP submission guard: at most four jobs per hour. Old rate-limit counters are also cleaned by the scheduled worker.
- The R2 bucket must remain private. Do not enable public bucket access or expose R2 credentials.

## Render environment

- GitHub-hosted `ubuntu-latest` runner, FFmpeg, Python 3.12, Pillow, Requests, faster-whisper and boto3.
- Whisper model weights are cached between compatible workflow runs where possible.
- One render job has a 90-minute workflow timeout. The number and duration of jobs are subject to the GitHub Actions plan's included runner minutes and concurrency limits.
- R2 storage and operations are subject to the Cloudflare plan's quotas and pricing. Immediate delete-after-download plus 24-hour expiry minimizes retained media but does not make compute/storage literally unlimited.
- No media files are committed to GitHub. Audio and generated videos are held in private R2 and ephemeral runner storage.

## Open image sources

The Python render engine searches Wikimedia Commons, Openverse and Library of Congress public collections without a paid provider key. It selects records only when metadata states a reuse-friendly license/rights status, records the author, source page and license, and uses original graphics if no suitable file can be fetched. Publicly viewable images are not automatically free to reuse; review the generated sources-and-licenses report and each file's actual terms.

## Troubleshooting

- If job submission says R2 is not bound, verify Pages binding `SHORTS_JOBS` and redeploy.
- If job submission says the background worker cannot start, check the Pages secret `GITHUB_ACTIONS_TOKEN` and repository Actions permission.
- If workflow starts but reports R2 auth failure, check `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME`.
- If iPhone Safari is closed, the GitHub-hosted runner continues. Reopen the site in the same browser profile to resume using the saved job token.
- If the user does not download and confirm, the scheduled 24-hour expiry cleanup is the fallback.