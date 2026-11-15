// Local preview: runs the real plugin backend against a throwaway library and serves the built
// screen with a stand-in host, so the reader can be opened in any browser without a Gateway.
//   npm run build && node dev/serve.mjs   →   http://127.0.0.1:4173/
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.OPENCLAW_RSS_DB ??= path.join(mkdtempSync(path.join(tmpdir(), "openclaw-rss-dev-")), "library.db");

const actions = new Map();
const plugin = (await import(path.join(root, "dist/index.js"))).default;
plugin.register({
  id: "rss",
  logger: { info: console.log, warn: console.warn, error: console.error },
  registerService() {},
  registerTool() {},
  registerCommand() {},
  session: { controls: { registerSessionAction: (action) => actions.set(action.id, action.handler), registerControlUiDescriptor() {} } },
});

const manifest = JSON.parse(readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
const entry = manifest.controlUi.entry;
const styles = manifest.controlUi.styles ?? manifest.controlUi.css ?? [];
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>RSS preview</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${[styles].flat().map((href) => `<link rel="stylesheet" href="/${href}">`).join("")}
<style>
  /* A copy of the Control UI's default theme colours, so the preview looks like the real page. */
  :root { --bg:#faf9f7; --bg-elevated:#fff; --card:#fff; --popover:#fff; --bg-hover:#efebe4; --text:#403c35; --text-strong:#211e1a; --muted:#6e6960;
    --border:#e8e4dc; --input:#e8e4dc; --accent:#bd4531; --accent-hover:#a83c29; --accent-subtle:#bd453114; --accent-foreground:#fff; --ring:#bd4531; --danger:#b91c1c;
    --radius-sm:6px; --radius-md:8px; --radius-lg:12px; --shadow-sm:0 1px 2px #3c2a180d; --shadow-lg:0 12px 28px #3c2a1817; color-scheme: light; }
  :root.dark { --bg:#111318; --bg-elevated:#22252b; --card:#22252b; --popover:#22252b; --bg-hover:#2a2d34; --text:#d7d9de; --text-strong:#f4f5f7; --muted:#8e8e97;
    --border:#2a2d33; --input:#2a2d33; --accent:#ff5c5c; --accent-hover:#ff7070; --accent-subtle:#ff5c5c1f; --danger:#ef4444; color-scheme: dark; }
  html, body { height:100%; margin:0; font: 14px/1.45 -apple-system, system-ui, sans-serif; background:var(--bg); color:var(--text); }
  #app { height:100vh; }
</style></head><body><div id="app"></div>
<script type="module">
  import plugin from "/${entry}";
  const controller = new AbortController();
  window.sent = [];
  const host = {
    pluginId: "rss", signal: controller.signal, connection: { connected: true },
    request: async (method, params) => {
      if (method !== "plugins.sessionAction") { window.sent.push({ method, params }); return {}; }
      const response = await fetch("/action", { method: "POST", body: JSON.stringify(params) });
      return response.json();
    },
    onEvent: () => () => {}, subscribe: () => () => {},
    agents: { selectedId: "main", defaultId: "main", rows: [{ id: "main" }] },
    sessions: { create: async () => "preview-session", open() {} },
    ui: { registerNavigation: () => () => {}, registerPage: (definition) => { window.page = definition; return () => {}; } },
  };
  if (new URLSearchParams(location.search).has("dark")) document.documentElement.classList.add("dark");
  plugin.activate(host);
  window.view = window.page.mount(document.getElementById("app"), { host, signal: controller.signal, props: {}, presented: true });
  // ?open=N clicks the Nth article once the list has loaded, for screenshots.
  const pick = Number(new URLSearchParams(location.search).get("open"));
  if (pick) {
    const timer = setInterval(() => {
      const rows = document.querySelectorAll(".rss-card");
      if (rows.length >= pick) { clearInterval(timer); rows[pick - 1].click(); }
    }, 100);
  }
</script></body></html>`;

createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/action") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { actionId, payload } = JSON.parse(body);
      const handler = actions.get(actionId);
      let result;
      try { result = handler ? await handler({ payload }) : { ok: false, error: `unknown action ${actionId}` }; }
      catch (error) { console.error(actionId, error); result = { ok: false, error: "plugin session action failed" }; }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      return;
    }
    if (request.url === "/" || request.url?.startsWith("/?")) { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page); return; }
    const file = path.normalize(path.join(root, decodeURIComponent(new URL(request.url, "http://x").pathname)));
    if (!file.startsWith(path.join(root, "dist") + path.sep)) { response.writeHead(404).end(); return; }
    const type = file.endsWith(".css") ? "text/css" : "text/javascript";
    response.writeHead(200, { "content-type": type }).end(readFileSync(file));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
}).listen(Number(process.env.PORT ?? 4173), "127.0.0.1", () => console.log(`RSS preview: http://127.0.0.1:${process.env.PORT ?? 4173}/  (library: ${process.env.OPENCLAW_RSS_DB})`));
