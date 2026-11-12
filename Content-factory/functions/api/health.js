export async function onRequestGet() {
  return Response.json({
    ok: true,
    app: "Content Factory",
    mode: "cloudflare-pages-free-agent-hub",
    mediaProcessing: "separate-render-engine-required",
    agents: "available",
    storage: "no-cloud-media-storage",
    timestamp: new Date().toISOString()
  });
}
