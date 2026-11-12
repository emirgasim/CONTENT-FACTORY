export async function onRequestGet() {
  return Response.json({
    ok: true,
    app: "Content Factory",
    mode: "starter",
    mediaProcessing: "not-configured",
    storage: "no-cloud-media-storage",
    timestamp: new Date().toISOString()
  });
}
