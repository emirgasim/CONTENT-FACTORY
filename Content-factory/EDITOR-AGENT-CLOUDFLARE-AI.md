# Cloudflare Workers AI — Editor agent

The editor's natural-language command panel uses the Cloudflare Workers AI binding and the Google Gemma 4 26B A4B instruct model.

## Cloudflare Pages configuration

The `wrangler.toml` file declares the Workers AI binding:

```toml
[ai]
binding = "AI"
```

Deploy the Pages project with project root `Content-factory` and output directory `public`. The global Pages middleware injects `/editor-agent.js` only into `/editor.html`; the rest of the app is unchanged.

## How approval works

1. The browser sends the user's command and a limited scene summary to `/api/editor/agent`.
2. Gemma 4 returns a structured JSON plan.
3. The server validates every operation against the actual scene count and available options.
4. The editor shows the proposed changes. Nothing changes until the user presses **Öneriyi taslağa uygula**.
5. The existing **Görsel seçimlerini onayla ve MP4 üret** step remains a separate approval.

Supported operations: select scene, move scene to the beginning, set scene duration, choose the next existing image alternative, and navigate next/previous.

## Important current limitation

The current cloud render worker accepts approved image candidate IDs, but does not yet consume timeline order/duration overrides. AI-approved timeline edits are real editor-state changes and can be undone while the editor is open, but they are not yet reflected in the final MP4. The existing UI continues to label those timing/order edits as draft-only. Do not represent the final render as incorporating those overrides until the renderer pipeline is extended.

## Model and cost

Model: `@cf/google/gemma-4-26b-a4b-it`. Workers AI usage is metered in Neurons and subject to the account's current free allocation, model availability, and rate limits. The application does not contain a model API key.
