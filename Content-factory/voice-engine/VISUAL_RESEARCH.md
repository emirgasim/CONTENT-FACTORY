# Content Factory — Visual Research Engine

The cloud renderer uses a federated image-research layer. It searches multiple independent providers per narration scene, deduplicates image URLs, downloads only valid image files, and records source/creator/rights metadata in `sources-and-licenses.txt`.

## Providers

### No-key providers
- Openverse
- Wikimedia Commons
- Library of Congress
- NASA Images and Media API
- Google Images, Bing Images, and Yandex Images public result pages (best-effort fallback; HTML layouts, bot checks, and regional access can change without notice)

### Optional API integrations
Configure these as **GitHub Actions repository secrets** (Settings → Secrets and variables → Actions) for `emirgasim/CONTENT-FACTORY`. The background renderer workflow passes them securely to the cloud worker:

| Secret | Provider | Notes |
|---|---|---|
| `PEXELS_API_KEY` | Pexels | Official API; key required |
| `PIXABAY_API_KEY` | Pixabay | Official API; key required |
| `UNSPLASH_ACCESS_KEY` | Unsplash | Official API; key required |
| `FLICKR_API_KEY` | Flickr | Official API; key required |
| `EUROPEANA_API_KEY` | Europeana | Official API; key required |

The engine works without these keys, but adding them substantially expands the search pool and makes retrieval more reliable than scraping search pages.

## Search and selection behavior

- Queries are generated per caption/scene, not just from the video title.
- Provider calls run concurrently; an unavailable provider does not block the others.
- Duplicate image URLs are discarded within a render.
- Images are downloaded and decoded with Pillow before use; HTML error pages and invalid image payloads are rejected.
- A source manifest is produced with title, source/provider, creator, source page, license label, and license URL whenever available.
- Search results with missing or unclear rights metadata are not silently labelled public domain. They are marked as unknown / verify rights in the source manifest.
- Provider terms, API quotas, hotlinking rules, and local copyright law still apply. Public discoverability is not a grant of reuse rights. Review unclear or restricted assets before commercial publication.

## Operational limits

Google, Bing, and Yandex public HTML pages are best-effort fallbacks, not stable APIs. They can return empty results or block automated traffic. Official provider APIs are preferred whenever credentials are configured. Search coverage can never guarantee every website on the internet; authenticated, private, robots-blocked, paywalled, or technically inaccessible sites are not crawled.
