const TTL_SECONDS = 86400;
const STALE_TIMEOUT_MS = 45 * 60 * 1000;
const ALLOWED_TRANSITIONS = new Set(["cut", "fade", "dissolve", "zoom_in", "slide_left"]);

const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store" }
});

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function owns(kv, id, request) {
  if (!/^[a-f0-9]{32}$/.test(id)) return false;
  const token = request.headers.get("X-Job-Token") || "";
  if (token.length < 32) return false;
  const obj = await kv.get("jobs/" + id + "/owner.json", "json");
  return !!obj && (await digest(token)) === obj.token_hash;
}

async function removePrefix(kv, media, prefix) {
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor, limit: 1000 });
    if (page.keys.length) await Promise.all(page.keys.map(x => kv.delete(x.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function sanitizeTimeline(timeline, manifest) {
  if (!Array.isArray(timeline) || !timeline.length) return null;
  const byIndex = new Map((manifest?.scenes || []).map(s => [Number(s.index), s]));
  const result = [];

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (!item || typeof item !== "object") continue;
    const origIndex = Number(item.sourceSceneIndex || item.scene || item.index);
    const baseScene = byIndex.get(origIndex);
    if (!baseScene) continue;

    const chosenId = Number(item.candidate);
    const option = (baseScene.options || []).find(x => Number(x.id) === chosenId);
    const externalUrl = String(item.externalUrl || "").trim();
    const hasExternal = /^https:\/\/.+/i.test(externalUrl);
    if (!option && !hasExternal) continue;

    const duration = Math.max(0.4, Math.min(180, Number(item.duration) || (Number(baseScene.end) - Number(baseScene.start)) || 2.5));
    const transition = ALLOWED_TRANSITIONS.has(String(item.transition || "")) ? String(item.transition) : "cut";
    const framing = item.framing && typeof item.framing === "object"
      ? {
          scale: Math.max(0.8, Math.min(2.5, Number(item.framing.scale) || 1.0)),
          panX: Math.max(-50, Math.min(50, Number(item.framing.panX) || 0)),
          panY: Math.max(-50, Math.min(50, Number(item.framing.panY) || 0))
        }
      : { scale: 1.0, panX: 0, panY: 0 };

    const metadata = hasExternal
      ? {
          title: String(item.metadata?.title || "Harici Görsel").slice(0, 140),
          author: String(item.metadata?.author || "").slice(0, 100),
          license: String(item.metadata?.license || "Belirtilmedi").slice(0, 80),
          license_url: String(item.metadata?.license_url || "").slice(0, 300),
          page_url: String(item.metadata?.page_url || externalUrl).slice(0, 300),
          url: externalUrl,
          source: String(item.metadata?.source || "Açık Kaynak").slice(0, 60)
        }
      : {
          title: option.title,
          author: option.author,
          license: option.license,
          license_url: option.license_url,
          page_url: option.page_url,
          url: "",
          source: option.source
        };

    result.push({
      order: i + 1,
      scene: origIndex,
      candidate: hasExternal ? 0 : option.id,
      external_url: hasExternal ? externalUrl : "",
      duration: Math.round(duration * 100) / 100,
      text: String(item.text ?? baseScene.text ?? "").slice(0, 300),
      transition,
      framing,
      metadata
    });
  }

  return result.length ? result : null;
}

export async function onRequestGet({ request, env, params }) {
  const kv = env.SHORTS_TEMP;
  if (!kv) return json({ error: "Geçici KV depolama bağlı değil." }, 503);
  const id = String(params.jobId || "");
  if (!await owns(kv, id, request)) return json({ error: "İş bulunamadı veya erişim anahtarı geçersiz." }, 404);

  const statusRaw = await kv.get("jobs/" + id + "/status.json");
  if (!statusRaw) return json({ error: "İş süresi dolmuş veya silinmiş." }, 404);

  const data = JSON.parse(statusRaw);
  const updatedMs = Date.parse(data.updated_at || data.created_at || "");
  if ((data.status === "queued" || data.status === "processing" || data.status === "uploading") && Number.isFinite(updatedMs)) {
    if (Date.now() - updatedMs > STALE_TIMEOUT_MS) {
      data.status = "failed";
      data.stale_timeout = true;
      data.message = "Bulut işçisi 45 dakikadan uzun süre yanıt vermediği için iş zaman aşımına uğradı.";
      await kv.put("jobs/" + id + "/status.json", JSON.stringify(data), { expirationTtl: TTL_SECONDS });
    }
  }

  if (data.status === "awaiting_approval") {
    data.review = await kv.get("jobs/" + id + "/review/manifest.json", "json");
    data.draft = await kv.get("jobs/" + id + "/draft.json", "json");
  }
  return json(data);
}

export async function onRequestDelete({ request, env, params }) {
  const kv = env.SHORTS_TEMP;
  if (!kv) return json({ error: "Geçici KV depolama bağlı değil." }, 503);
  const id = String(params.jobId || "");
  if (!await owns(kv, id, request)) return json({ error: "İş bulunamadı veya erişim anahtarı geçersiz." }, 404);

  await removePrefix(kv, media, "jobs/" + id + "/");
  return json({
    ok: true,
    deleted: true,
    message: "Ses, metin, referans görseller, ara dosyalar ve MP4 geçici depolamadan silindi."
  });
}

export async function onRequestPatch({ request, env, params }) {
  const kv = env.SHORTS_TEMP;
  const id = String(params.jobId || "");
  if (!kv || !await owns(kv, id, request)) {
    return json({ error: "İş bulunamadı veya erişim anahtarı geçersiz." }, 404);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Geçersiz taslak verisi." }, 400);
  }
  const draft = {
    updated_at: new Date().toISOString(),
    timeline: Array.isArray(body?.timeline) ? body.timeline.slice(0, 100) : [],
    audioMix: body?.audioMix || { voiceVolume: 1.0, musicVolume: 0.35 }
  };
  await kv.put("jobs/" + id + "/draft.json", JSON.stringify(draft), { expirationTtl: TTL_SECONDS });
  return json({ ok: true, saved: true, updated_at: draft.updated_at });
}

export async function onRequestPost({ request, env, params }) {
  const kv = env.SHORTS_TEMP;
  const id = String(params.jobId || "");
  if (!kv || !await owns(kv, id, request)) {
    return json({ error: "İş bulunamadı veya erişim anahtarı geçersiz." }, 404);
  }

  const status = await kv.get("jobs/" + id + "/status.json", "json");
  if (!status || status.status !== "awaiting_approval") {
    return json({ error: "Bu proje görsel onayı beklemiyor." }, 409);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Geçersiz seçim verisi." }, 400);
  }

  const manifest = await kv.get("jobs/" + id + "/review/manifest.json", "json");
  if (!manifest?.scenes?.length) return json({ error: "Sahne manifestosu bulunamadı." }, 400);

  let scenes = sanitizeTimeline(body?.timeline, manifest);

  // Backward-compatible fallback for legacy { selections: { "1": "2" } } payloads
  if (!scenes && body?.selections && typeof body.selections === "object") {
    scenes = [];
    for (const scene of manifest.scenes) {
      const chosen = String(body.selections[String(scene.index)] || "");
      const option = scene.options.find(x => String(x.id) === chosen);
      if (!option) {
        return json({ error: "Her sahne için geçerli bir görsel seçmelisin. Sahne " + scene.index }, 400);
      }
      scenes.push({
        order: scenes.length + 1,
        scene: scene.index,
        candidate: option.id,
        external_url: "",
        duration: Math.max(0.5, Math.round(((Number(scene.end) || 0) - (Number(scene.start) || 0)) * 100) / 100) || 2.5,
        text: String(scene.text || ""),
        transition: "cut",
        framing: { scale: 1.0, panX: 0, panY: 0 },
        metadata: {
          title: option.title,
          author: option.author,
          license: option.license,
          license_url: option.license_url,
          page_url: option.page_url,
          url: "",
          source: option.source
        }
      });
    }
  }

  if (!scenes || !scenes.length) {
    return json({ error: "Geçerli sahne düzenlemesi veya görsel seçimi eksik." }, 400);
  }

  const audioMix = {
    voiceVolume: Math.max(0, Math.min(2, Number(body?.audioMix?.voiceVolume ?? 1.0))),
    musicVolume: Math.max(0, Math.min(1.5, Number(body?.audioMix?.musicVolume ?? 0.35)))
  };

  await kv.put("jobs/" + id + "/selection.json", JSON.stringify({ scenes, audio_mix: audioMix }), {
    expirationTtl: TTL_SECONDS
  });
  await kv.put("jobs/" + id + "/status.json", JSON.stringify({
    ...status,
    status: "queued",
    progress: 88,
    message: "Onayladığın kurgu ve görsellerle bulut MP4 üretiliyor.",
    updated_at: new Date().toISOString()
  }), { expirationTtl: TTL_SECONDS });

  const gh = await fetch(
    "https://api.github.com/repos/emirgasim/CONTENT-FACTORY/actions/workflows/shorts-background.yml/dispatches",
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(env.GITHUB_ACTIONS_TOKEN || "").trim(),
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "ContentFactory-CloudRenderer"
      },
      body: JSON.stringify({ ref: "main", inputs: { job_id: id, phase: "render" } })
    }
  );

  if (gh.status !== 204) {
    await kv.put("jobs/" + id + "/status.json", JSON.stringify(status), { expirationTtl: TTL_SECONDS });
    return json({ error: "Render başlatılamadı (HTTP " + gh.status + ")." }, 502);
  }

  return json({ ok: true, status: "queued", scene_count: scenes.length });
}
