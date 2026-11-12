# Content Factory — R2-free cloud rendering setup

This branch replaces the Cloudflare R2 dependency with temporary Cloudflare Workers KV storage. iPhone remains a control panel; FFmpeg/Python rendering runs in GitHub Actions.

## Required one-time setup

1. In Cloudflare, create a Workers KV namespace named `CONTENT_FACTORY_TEMP`.
2. In the Cloudflare Pages project **content-factory**, open Settings → Functions → KV namespace bindings and bind:
   - Variable name: `SHORTS_TEMP`
   - KV namespace: `CONTENT_FACTORY_TEMP`
3. In Cloudflare Pages → Settings → Environment variables, add:
   - `GITHUB_ACTIONS_TOKEN`: a fine-grained GitHub token for `emirgasim/CONTENT-FACTORY` with **Actions: Read and write** permission. It is used only to dispatch the workflow.
   - `CF_WORKER_SECRET`: a long random secret (at least 32 characters).
4. In GitHub repository Settings → Secrets and variables → Actions → New repository secret, add:
   - `CONTENT_FACTORY_URL`: the deployed Pages origin, e.g. `https://content-factory-7s6.pages.dev` (no trailing slash).
   - `CF_WORKER_SECRET`: exactly the same value as the Cloudflare Pages secret.
5. Deploy the Pages project from this branch (or merge it to main and let Pages deploy main). Ensure the Pages project root is `Content-factory` and output directory is `public`.

## Storage and deletion behavior

- Input and output files are stored as 16 MiB chunks in KV; no single KV value exceeds the chunk size.
- Every job key receives a 24-hour TTL. KV expires abandoned jobs automatically.
- The user can explicitly delete a completed or failed job from the app; deletion removes every key under that job prefix.
- The hourly IP rate-limit key expires after one hour.
- No R2 bucket, R2 access key, Boto3, or paid video API is used by this pipeline.

## Free-tier constraints

KV is temporary object storage, not unlimited storage. Free-plan quotas and Cloudflare request/body limits still apply. The app limits audio to 30 MiB and user reference images to eight files of 8 MiB each. The 16 MiB chunking keeps each KV value below the 25 MiB per-value limit. A job can still fail if the account reaches its daily KV write/read or storage quota.

## Validation

GitHub Actions workflow `Validate Content Factory` checks frontend JavaScript, Pages Functions, and Python syntax on push/PR. The `Shorts Factory Background Renderer` workflow installs FFmpeg and Python dependencies, fetches private job data through the authenticated Pages internal API, renders, uploads chunked outputs, and reports status.

