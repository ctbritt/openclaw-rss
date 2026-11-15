import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { collapse, decodeEntities, escapeHtml, safeHttpUrl } from "./text.js";

export type ParsedItem = {
  guid: string;
  url: string | null;
  title: string;
  author: string;
  publishedAt: number | null;
  /** Raw publisher HTML; sanitize before storing or showing. */
  html: string;
  /** Lead image the feed declared for the entry (media thumbnail or image enclosure), if any. */
  image: string | null;
};

export type ParsedFeed = {
  kind: "rss" | "atom" | "rdf";
  title: string;
  siteUrl: string | null;
  items: ParsedItem[];
};

type Node = Record<string, unknown>;

// Body fields are kept as raw text so embedded markup (CDATA, escaped HTML, Atom XHTML)
// reaches the sanitizer intact instead of being turned into an object tree.
const BODY_FIELDS = ["description", "content:encoded", "content", "summary"];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  stopNodes: BODY_FIELDS.map((name) => `*.${name}`),
  isArray: (name) => name === "item" || name === "entry" || name === "link" || name === "category",
});

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (isNode(value)) return text(value["#text"]);
  return "";
}

function attr(value: unknown, name: string): string {
  return isNode(value) && typeof value[`@_${name}`] === "string" ? (value[`@_${name}`] as string) : "";
}

/** Titles may carry CDATA remnants, escaped markup or stray tags; reduce them to one line of text. */
function plain(value: unknown): string {
  return collapse(decodeEntities(text(value).replace(/<[^>]*>/gu, " ")));
}

/** Turn a raw body field into HTML, whatever encoding the publisher chose. */
export function rawBodyToHtml(value: unknown): string {
  const raw = text(value).trim();
  if (!raw) return "";
  const type = attr(value, "type").toLowerCase();
  if (raw.includes("<![CDATA[")) {
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, (_whole, inner: string) => inner);
  }
  if (type === "xhtml") return raw;
  if (type === "text") return escapeHtml(decodeEntities(raw));
  return decodeEntities(raw);
}

function parseDate(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    const value = text(candidate).trim();
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function atomLink(links: unknown, base?: string): string | null {
  const list = Array.isArray(links) ? links : links === undefined ? [] : [links];
  let fallback: string | null = null;
  for (const link of list) {
    const href = attr(link, "href") || text(link);
    const rel = attr(link, "rel") || "alternate";
    const url = href ? safeHttpUrl(href, base) : null;
    if (!url) continue;
    if (rel === "alternate") return url;
    fallback ??= rel === "self" ? null : url;
  }
  return fallback;
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.length > 0) ?? "";
}

/** The picture a feed attaches to an entry: Media RSS thumbnail or content, or an image enclosure. */
function leadImage(entry: Node, base?: string): string | null {
  const many = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);
  const group = many(entry["media:group"])[0];
  const scopes = [entry, ...(isNode(group) ? [group] : [])];
  const candidates: string[] = [];
  for (const scope of scopes) for (const node of many(scope["media:thumbnail"])) candidates.push(attr(node, "url"));
  for (const scope of scopes) {
    for (const node of many(scope["media:content"])) {
      const type = attr(node, "type").toLowerCase();
      const medium = attr(node, "medium").toLowerCase();
      const url = attr(node, "url");
      if (medium === "image" || type.startsWith("image/") || (!type && !medium && /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/iu.test(url))) candidates.push(url);
    }
  }
  for (const node of many(entry.enclosure)) if (attr(node, "type").toLowerCase().startsWith("image/")) candidates.push(attr(node, "url"));
  for (const node of many(entry.link)) {
    if (attr(node, "rel") === "enclosure" && attr(node, "type").toLowerCase().startsWith("image/")) candidates.push(attr(node, "href"));
  }
  for (const candidate of candidates) {
    const url = candidate ? safeHttpUrl(candidate, base) : null;
    if (url) return url;
  }
  return null;
}

function stableGuid(explicit: string, url: string | null, title: string, publishedAt: number | null): string {
  if (explicit) return explicit.slice(0, 500);
  if (url) return url.slice(0, 500);
  return "sha1:" + createHash("sha1").update(`${title}\n${publishedAt ?? ""}`).digest("hex");
}

function rssItem(item: Node, base?: string): ParsedItem {
  const linkText = text(item.link).trim();
  const guidText = text(item.guid).trim();
  const permalink = attr(item.guid, "isPermaLink").toLowerCase() !== "false" && /^https?:/iu.test(guidText) ? guidText : "";
  const url = safeHttpUrl(firstNonEmpty(linkText, permalink), base);
  const title = plain(item.title);
  const publishedAt = parseDate(item.pubDate, item["dc:date"], item.date);
  const encoded = rawBodyToHtml(item["content:encoded"]);
  const description = rawBodyToHtml(item.description);
  return {
    guid: stableGuid(firstNonEmpty(guidText, attr(item, "rdf:about")), url, title, publishedAt),
    url,
    title: title || "(untitled)",
    author: plain(item["dc:creator"]) || plain(item.author),
    publishedAt,
    html: encoded.length >= description.length ? encoded : description,
    image: leadImage(item, base),
  };
}

function atomEntry(entry: Node, base?: string): ParsedItem {
  const url = atomLink(entry.link, base);
  const title = plain(entry.title);
  const publishedAt = parseDate(entry.published, entry.updated, entry.issued, entry.modified);
  const content = rawBodyToHtml(entry.content);
  const summary = rawBodyToHtml(entry.summary);
  const author = isNode(entry.author) ? plain(entry.author.name) : plain(entry.author);
  return {
    guid: stableGuid(text(entry.id).trim(), url, title, publishedAt),
    url,
    title: title || "(untitled)",
    author,
    publishedAt,
    html: content || summary,
    image: leadImage(entry, base),
  };
}

/** Parse RSS 2.0, RSS 1.0 (RDF) or Atom. Throws when the document is none of them. */
export function parseFeed(xml: string, feedUrl?: string): ParsedFeed {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (error) {
    throw new Error(`Not a readable feed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isNode(doc.rss) && isNode(doc.rss.channel)) {
    const channel = doc.rss.channel;
    const siteUrl = safeHttpUrl(text((channel.link as unknown[] | undefined)?.find?.((entry) => typeof entry === "string") ?? ""), feedUrl);
    const base = siteUrl ?? feedUrl;
    const items = (Array.isArray(channel.item) ? channel.item : []).filter(isNode).map((item) => rssItem(item, base));
    return { kind: "rss", title: plain(channel.title), siteUrl, items };
  }
  if (isNode(doc.feed)) {
    const feed = doc.feed;
    const siteUrl = atomLink(feed.link, feedUrl);
    const base = siteUrl ?? feedUrl;
    const items = (Array.isArray(feed.entry) ? feed.entry : []).filter(isNode).map((entry) => atomEntry(entry, base));
    return { kind: "atom", title: plain(feed.title), siteUrl, items };
  }
  const rdf = doc["rdf:RDF"] ?? doc.RDF;
  if (isNode(rdf)) {
    const channel = isNode(rdf.channel) ? rdf.channel : {};
    const siteUrl = safeHttpUrl(text(channel.link), feedUrl);
    const base = siteUrl ?? feedUrl;
    const items = (Array.isArray(rdf.item) ? rdf.item : []).filter(isNode).map((item) => rssItem(item, base));
    return { kind: "rdf", title: plain(channel.title), siteUrl, items };
  }
  throw new Error("Not a readable feed: no RSS, Atom or RDF content found.");
}

/** Feed addresses advertised by an ordinary web page. */
export function discoverFeedLinks(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  for (const match of html.slice(0, 400_000).matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const get = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
    const value = (name: string) => { const m = get(name); return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : ""; };
    if (!/\balternate\b/iu.test(value("rel"))) continue;
    if (!/(rss|atom)\+xml|application\/feed\+json/iu.test(value("type")) || /json/iu.test(value("type"))) continue;
    const url = safeHttpUrl(value("href"), pageUrl);
    if (url && !found.includes(url)) found.push(url);
  }
  return found;
}
