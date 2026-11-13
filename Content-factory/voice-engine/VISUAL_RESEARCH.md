# Content Factory — Visual Research Engine

The cloud renderer uses a federated image-research layer. It searches multiple independent providers per narration scene, deduplicates image URLs, downloads only valid image files, and records source/creator/rights metadata in `sources-and-licenses.txt`.

## Providers

**No API key or account setup is required for the default search path.** The renderer must remain fully functional when every optional API secret is absent.

### No-key providers
- Openverse
- Wikimedia Commons
- Library of Congress
- NASA Images and Media API
- DuckDuckGo Images (best-effort, keyless image endpoint)
- Google Images, Bing Images, and Yandex Images public result pages (best-effort fallback; HTML layouts, bot checks, and regional access can change without notice)

### Optional API integrations
These integrations are enhancements only. **Do not stop setup or video generation to obtain these keys.** If the owner later chooses to add one, it can be stored as a GitHub Actions repository secret and passed securely to the cloud worker:

| Secret | Provider | Notes |
|---|---|---|
| `PEXELS_API_KEY` | Pexels | Official API; key required |
| `PIXABAY_API_KEY` | Pixabay | Official API; key required |
| `UNSPLASH_ACCESS_KEY` | Unsplash | Official API; key required |
| `FLICKR_API_KEY` | Flickr | Official API; key required |
| `EUROPEANA_API_KEY` | Europeana | Official API; key required |

The engine works without any of these keys. Missing keys are treated as an unavailable optional provider, never as a fatal configuration error.

## Search and selection behavior

- Queries are generated per caption/scene, not just from the video title.
- No-key providers are always attempted; optional API providers are added only when their credentials exist.
- Provider calls run concurrently; an unavailable provider does not block the others.
- Duplicate image URLs are discarded within a render.
- Images are downloaded and decoded with Pillow before use; HTML error pages and invalid image payloads are rejected.
- A source manifest is produced with title, source/provider, creator, source page, license label, and license URL whenever available.
- Search results with missing or unclear rights metadata are not silently labelled public domain. They are marked as unknown / verify rights in the source manifest.
- Provider terms, API quotas, hotlinking rules, and local copyright law still apply. Public discoverability is not a grant of reuse rights. Review unclear or restricted assets before commercial publication.

## Operational limits

Google, Bing, and Yandex public HTML pages are best-effort fallbacks, not stable APIs. They can return empty results or block automated traffic. Official provider APIs are preferred whenever credentials are configured. Search coverage can never guarantee every website on the internet; authenticated, private, robots-blocked, paywalled, or technically inaccessible sites are not crawled.
