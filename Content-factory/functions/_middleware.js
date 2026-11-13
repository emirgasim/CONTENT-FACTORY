export async function onRequest(context) {
  const response = await context.next();
  const url = new URL(context.request.url);
  if (url.pathname !== "/editor.html") return response;

  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("text/html")) return response;

  const html = await response.text();
  if (html.includes("/editor-agent.js")) return new Response(html, response);

  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("ETag");
  headers.set("Cache-Control", "no-store");
  const injected = html.replace(
    "</body>",
    '<script src="/editor-agent.js" defer></script></body>'
  );
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
