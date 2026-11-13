import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import assert from "node:assert/strict";
import { onRequestPost as agentPost, validateActions, parseModelJson } from "../functions/api/editor/agent.js";
import { onRequestPut as internalAssetPut } from "../functions/api/internal/shorts/jobs/[jobId]/[asset].js";
import { onRequestGet as jobGet, onRequestPatch as jobPatch, onRequestPost as jobPost, onRequestDelete as jobDelete } from "../functions/api/shorts/jobs/[jobId].js";

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const val = store.get(key);
      if (type === "json") return typeof val === "string" ? JSON.parse(val) : val;
      return typeof val === "string" ? val : JSON.stringify(val);
    },
    async put(key, val) {
      store.set(key, val);
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true };
    }
  };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

// 1. Test validateActions & parseModelJson
{
  const scenes = [
    { text: "Birinci sahne", options: [{ id: 1, title: "A" }] },
    { text: "İkinci sahne", options: [{ id: 1, title: "B" }] }
  ];
  const actions = validateActions([
    { type: "adjust_scene_duration", scene: 1, delta: 3 },
    { type: "move_scene_to_start", scene: 2 },
    { type: "search_new_visual", scene: 1, query: "cinematic city night", replaceCurrent: true },
    { type: "set_transition", scene: 2, transition: "dissolve" },
    { type: "set_framing", scene: 1, scale: 1.3, panX: 10, panY: -5 },
    { type: "set_audio_mix", musicVolume: 0.2 },
    { type: "set_pacing", factor: 0.85 },
    { type: "set_transition", scene: 99, transition: "invalid" }
  ], scenes);

  assert.equal(actions.length, 7);
  assert.equal(actions[0].delta, 3);
  assert.equal(actions[2].query, "cinematic city night");
  assert.equal(actions[3].transition, "dissolve");
  assert.equal(actions[5].musicVolume, 0.2);

  const parsed = parseModelJson("```json\n{\"reply\":\"Tamam\",\"actions\":[]}\n```");
  assert.equal(parsed.reply, "Tamam");
}

// 2. Test agent.js onRequestPost proposal-then-approval
{
  const req = new Request("https://example.test/api/editor/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "Bu sahneyi 3 saniye uzat ve geçişini sinematik yap",
      activeScene: 1,
      scenes: [{ text: "Merhaba dünya", duration: 2.5, options: [{ title: "Foto" }] }]
    })
  });
  const res = await agentPost({
    request: req,
    env: {
      AI: {
        async run() {
          return {
            response: JSON.stringify({
              reply: "Sahne 1 süresini +3 sn uzatıp dissolve geçişi eklememi onaylar mısın?",
              actions: [
                { type: "adjust_scene_duration", scene: 1, delta: 3 },
                { type: "set_transition", scene: 1, transition: "dissolve" }
              ]
            })
          };
        }
      }
    }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.requires_approval, true);
  assert.equal(data.actions.length, 2);
}

// 3. Test internal/[asset].js manifest PUT fix
{
  const kv = makeKv();
  const jobId = "0123456789abcdef0123456789abcdef";
  const req = new Request(`https://example.test/api/internal/shorts/jobs/${jobId}/manifest`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Factory-Worker-Secret": "sec-123"
    },
    body: JSON.stringify({ type: "manifest", manifest: { video: { parts: 1, size: 1234 } } })
  });
  const res = await internalAssetPut({
    request: req,
    env: { SHORTS_TEMP: kv, CF_WORKER_SECRET: "sec-123" },
    params: { jobId, asset: "manifest" }
  });
  assert.equal(res.status, 200);
  const saved = await kv.get(`jobs/${jobId}/output/manifest.json`, "json");
  assert.equal(saved.video.size, 1234);
}

// 4. Test jobs/[jobId].js draft save, full timeline selection, stale timeout, and DELETE cleanup
{
  const kv = makeKv();
  const jobId = "abcdef0123456789abcdef0123456789";
  const token = "t".repeat(32);
  await kv.put(`jobs/${jobId}/owner.json`, JSON.stringify({ token_hash: await sha256Hex(token) }));
  await kv.put(`jobs/${jobId}/status.json`, JSON.stringify({
    job_id: jobId,
    status: "awaiting_approval",
    progress: 50,
    updated_at: new Date().toISOString()
  }));
  await kv.put(`jobs/${jobId}/review/manifest.json`, JSON.stringify({
    scenes: [
      { index: 1, text: "Bir", start: 0, end: 2, options: [{ id: 1, title: "G1", author: "A", license: "CC0", license_url: "", page_url: "", source: "Openverse" }] },
      { index: 2, text: "İki", start: 2, end: 5, options: [{ id: 1, title: "G2", author: "B", license: "CC0", license_url: "", page_url: "", source: "Wikimedia" }] }
    ]
  }));

  // PATCH draft
  const patchRes = await jobPatch({
    request: new Request(`https://example.test/api/shorts/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Job-Token": token },
      body: JSON.stringify({ timeline: [{ sourceSceneIndex: 2, duration: 4.5 }], audioMix: { voiceVolume: 1.0, musicVolume: 0.2 } })
    }),
    env: { SHORTS_TEMP: kv },
    params: { jobId }
  });
  assert.equal(patchRes.status, 200);

  // POST full edited timeline (mocking GitHub fetch)
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    const postRes = await jobPost({
      request: new Request(`https://example.test/api/shorts/jobs/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Job-Token": token },
        body: JSON.stringify({
          audioMix: { voiceVolume: 1.1, musicVolume: 0.2 },
          timeline: [
            { sourceSceneIndex: 2, candidate: 1, duration: 5.5, text: "İkinci başa geldi", transition: "dissolve", framing: { scale: 1.2, panX: 5, panY: -5 } },
            { sourceSceneIndex: 1, candidate: 0, externalUrl: "https://example.org/pic.jpg", duration: 3.0, text: "Birinci sona gitti", transition: "fade" }
          ]
        })
      }),
      env: { SHORTS_TEMP: kv, GITHUB_ACTIONS_TOKEN: "gh-tok" },
      params: { jobId }
    });
    assert.equal(postRes.status, 200);
    const sel = await kv.get(`jobs/${jobId}/selection.json`, "json");
    assert.equal(sel.scenes.length, 2);
    assert.equal(sel.scenes[0].scene, 2);
    assert.equal(sel.scenes[0].duration, 5.5);
    assert.equal(sel.scenes[0].transition, "dissolve");
    assert.equal(sel.scenes[1].external_url, "https://example.org/pic.jpg");
    assert.equal(sel.audio_mix.musicVolume, 0.2);
  } finally {
    globalThis.fetch = origFetch;
  }

  // DELETE cleanup
  const delRes = await jobDelete({
    request: new Request(`https://example.test/api/shorts/jobs/${jobId}`, {
      method: "DELETE",
      headers: { "X-Job-Token": token }
    }),
    env: { SHORTS_TEMP: kv },
    params: { jobId }
  });
  assert.equal(delRes.status, 200);
  const remaining = await kv.list({ prefix: `jobs/${jobId}/` });
  assert.equal(remaining.keys.length, 0);

  // Stale job timeout test
  const staleId = "11111111111111111111111111111111";
  await kv.put(`jobs/${staleId}/owner.json`, JSON.stringify({ token_hash: await sha256Hex(token) }));
  await kv.put(`jobs/${staleId}/status.json`, JSON.stringify({
    job_id: staleId,
    status: "queued",
    updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  }));
  const staleRes = await jobGet({
    request: new Request(`https://example.test/api/shorts/jobs/${staleId}`, {
      headers: { "X-Job-Token": token }
    }),
    env: { SHORTS_TEMP: kv },
    params: { jobId: staleId }
  });
  const staleData = await staleRes.json();
  assert.equal(staleData.status, "failed");
  assert.equal(staleData.stale_timeout, true);
}

console.log("ALL NODE API TESTS PASSED!");
