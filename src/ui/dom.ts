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

const ICONS = {
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  plus: ["M5 12h14", "M12 5v14"],
  pencil: ["M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", "m15 5 4 4"],
  chevronDown: ["m6 9 6 6 6-6"],
  chevronRight: ["m9 18 6-6-6-6"],
  filter: ["M22 3H2l8 9.46V19l4 2v-8.54L22 3z"],
  checkAll: ["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  bookmark: ["m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"],
  circle: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"],
  circleCheck: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "m9 12 2 2 4-4"],
  page: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10 9H8", "M16 13H8", "M16 17H8"],
  arrowOut: ["M7 7h10v10", "M7 17 17 7"],
  up: ["m5 12 7-7 7 7", "M12 19V5"],
  down: ["M12 5v14", "m19 12-7 7-7-7"],
  close: ["M18 6 6 18", "m6 6 12 12"],
} as const;

export type IconName = keyof typeof ICONS;

/** A small line icon drawn in the current text colour. Decorative: label the button, not the icon. */
export function icon(name: IconName, filled = false): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `rss-svg${filled ? " rss-svg-filled" : ""}`);
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
