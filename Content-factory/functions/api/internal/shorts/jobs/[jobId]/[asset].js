const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const CHUNK = 16 * 1024 * 1024;
const TTL_SECONDS = 86400;
function authorized(request, env) { const secret = env.CF_WORKER_SECRET || ""; return !!secret && request.headers.get("X-Factory-Worker-Secret") === secret; }
function validId(id) { return /^[a-f0-9]{32}$/.test(id); }
function streamParts(bucket, key, parts) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= parts) return controller.close();
      try {
        const object = await bucket.get(key + "/" + index);
        if (!object) throw Error("Missing R2 media chunk");
        controller.enqueue(new Uint8Array(await object.arrayBuffer()));
        index++;
      } catch (error) { controller.error(error); }
    }
  });
}
export async function onRequestGet({ request, env, params }) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  const kv = env.SHORTS_TEMP, media = env.SHORTS_MEDIA, id = String(params.jobId || ""), asset = String(params.asset || "");
  if (!kv || !media || !validId(id)) return json({ error: "Invalid job or R2 binding" }, 404);
  const meta = await kv.get("jobs/" + id + "/input.json", "json");
  if (!meta) return json({ error: "Job expired" }, 404);
  if (asset === "selection") {
    const selected = await kv.get("jobs/" + id + "/selection.json", "json");
    return selected ? json(selected) : json({ error: "Selection not found" }, 404);
  }
  let item;
  if (asset === "audio") item = meta.audio;
  else if (/^image-\d{2}$/.test(asset)) item = meta.images.find(x => x.key.endsWith("/" + asset));
  else if (/^candidate-\d+-\d+$/.test(asset)) {
    const manifest = await kv.get("jobs/" + id + "/review/manifest.json", "json");
    const bits = asset.split("-").map(Number);
    const option = manifest?.scenes?.[bits[1] - 1]?.options?.find(x => Number(x.id) === bits[2]);
    if (option) item = { key: "jobs/" + id + "/review/scene-" + bits[1] + "/candidate-" + bits[2], parts: option.parts, size: option.size, type: "image/jpeg" };
  }
  if (!item) return json({ error: "Input not found" }, 404);
  return new Response(streamParts(media, item.key, item.parts), { headers: {
    "Content-Type": item.type || "application/octet-stream", "Content-Length": String(item.size), "Cache-Control": "no-store"
  }});
}
export async function onRequestPut({ request, env, params }) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  const kv = env.SHORTS_TEMP, media = env.SHORTS_MEDIA, id = String(params.jobId || ""), asset = String(params.asset || "");
  if (!kv || !media || !validId(id)) return json({ error: "Invalid job or R2 binding" }, 400);
  if (asset === "manifest") {
    let body; try { body = await request.json(); } catch { return json({ error: "Invalid manifest" }, 400); }
    if (body?.type !== "manifest" || !body.manifest || typeof body.manifest !== "object") return json({ error: "Invalid manifest" }, 400);
    await kv.put("jobs/" + id + "/output/manifest.json", JSON.stringify(body.manifest), { expirationTtl: TTL_SECONDS });
    return json({ ok: true });
  }
  if (!/^output-(video|audio|credits)$/.test(asset) && !/^candidate-\d+-\d+$/.test(asset)) return json({ error: "Invalid output" }, 400);
  const url = new URL(request.url), part = Number(url.searchParams.get("part")), total = Number(url.searchParams.get("total"));
  if (!Number.isInteger(part) || !Number.isInteger(total) || part < 0 || total < 1 || part >= total || total > 128) return json({ error: "Invalid chunk index" }, 400);
  const body = await request.arrayBuffer();
  if (body.byteLength > CHUNK) return json({ error: "Chunk exceeds 16 MiB" }, 413);
  const key = /^candidate-\d+-\d+$/.test(asset)
    ? "jobs/" + id + "/review/scene-" + asset.split("-")[1] + "/candidate-" + asset.split("-")[2] + "/" + part
    : "jobs/" + id + "/output/" + asset.slice(7) + "/" + part;
  await media.put(key, body, { httpMetadata: { contentType: asset.startsWith("candidate-") ? "image/jpeg" : "application/octet-stream" } });
  return json({ ok: true, part, total, size: body.byteLength });
}
