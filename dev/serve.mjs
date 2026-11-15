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
  :root { --text:#1c1d21; --bg:#ffffff; --border:#dcdde2; --accent:#3b6ef5; --accent-foreground:#fff; --danger:#c93c3c; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --text:#e7e8ec; --bg:#16171b; --border:#2e3038; --accent:#6f95ff; color-scheme: dark; } }
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
  plugin.activate(host);
  window.view = window.page.mount(document.getElementById("app"), { host, signal: controller.signal, props: {}, presented: true });
  // ?open=N clicks the Nth article once the list has loaded, for screenshots.
  const pick = Number(new URLSearchParams(location.search).get("open"));
  if (pick) {
    const timer = setInterval(() => {
      const rows = document.querySelectorAll(".rss-article");
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
