// Minimal DOM helpers. Everything user- or publisher-supplied goes through textContent.

type Attrs = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.replace(/^on/u, "").toLowerCase(), value);
    else if (name === "class") element.className = String(value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

export function clear(element: Element): void {
  while (element.firstChild) element.firstChild.remove();
}

export function relativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: days > 300 ? "numeric" : undefined });
}

const ALLOWED = new Set([
  "P", "BR", "HR", "DIV", "SPAN", "BLOCKQUOTE", "PRE", "CODE", "KBD", "SAMP", "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "DL", "DT", "DD", "A", "B", "STRONG", "I", "EM", "U", "S", "DEL", "INS", "SUB", "SUP", "SMALL",
  "MARK", "ABBR", "CITE", "Q", "FIGURE", "FIGCAPTION", "IMG", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION",
]);
const ATTRS: Record<string, string[]> = {
  A: ["href", "title"], IMG: ["src", "alt"], TH: ["colspan", "rowspan", "scope"], TD: ["colspan", "rowspan"], ABBR: ["title"],
};

/**
 * Second line of defence for article bodies. The Gateway already sanitized this HTML; here it is
 * parsed inertly and rebuilt from an allowlist, so nothing active can reach the page even if the
 * stored copy were wrong. Images are dropped unless the reader opted in.
 */
export function renderArticleHtml(html: string, options: { images: boolean; skipImage?: string | null }): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const seen = new Set<string>();
  const copy = (source: Node, target: Node) => {
    for (const node of Array.from(source.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) { target.appendChild(document.createTextNode(node.textContent ?? "")); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as Element;
      if (!ALLOWED.has(element.tagName)) {
        if (!["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "SVG", "MATH"].includes(element.tagName.toUpperCase())) copy(element, target);
        continue;
      }
      if (element.tagName === "IMG") {
        const src = element.getAttribute("src") ?? "";
        // Feeds often repeat the lead image; show each picture once.
        if (!options.images || !/^https?:\/\//iu.test(src) || seen.has(src) || src === options.skipImage) continue;
        seen.add(src);
      }
      const next = document.createElement(element.tagName.toLowerCase());
      for (const name of ATTRS[element.tagName] ?? []) {
        const value = element.getAttribute(name);
        if (value === null) continue;
        if ((name === "href" && !/^(https?:|mailto:)/iu.test(value)) || (name === "src" && !/^https?:\/\//iu.test(value))) continue;
        next.setAttribute(name, value);
      }
      if (next.tagName === "A") { next.setAttribute("target", "_blank"); next.setAttribute("rel", "noopener noreferrer nofollow"); }
      if (next.tagName === "IMG") { next.setAttribute("loading", "lazy"); next.setAttribute("referrerpolicy", "no-referrer"); }
      copy(element, next);
      target.appendChild(next);
    }
  };
  const fragment = document.createDocumentFragment();
  copy(parsed.body, fragment);
  return fragment;
}

export function htmlToPlainText(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  parsed.querySelectorAll("p,br,li,h1,h2,h3,h4,h5,h6,blockquote,tr,div").forEach((node) => node.append("\n"));
  return (parsed.body.textContent ?? "").replace(/[ \t]+/gu, " ").replace(/\n\s*\n+/gu, "\n\n").trim();
}
