import { XMLParser } from "fast-xml-parser";
import { safeHttpUrl } from "./text.js";

export type OpmlFeed = { url: string; title: string; folder: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === "outline",
});

type Outline = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Read subscriptions from OPML. Nested folders collapse to "Parent / Child". */
export function parseOpml(xml: string): OpmlFeed[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Not a readable OPML file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (doc.opml as Record<string, unknown> | undefined)?.body as Record<string, unknown> | undefined;
  if (!body) throw new Error("Not a readable OPML file: no <opml><body> found.");
  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  const walk = (outlines: unknown, folder: string, depth: number) => {
    if (!Array.isArray(outlines) || depth > 8) return;
    for (const raw of outlines as Outline[]) {
      if (typeof raw !== "object" || raw === null) continue;
      const label = str(raw["@_title"]) || str(raw["@_text"]);
      const url = safeHttpUrl(str(raw["@_xmlUrl"]) || str(raw["@_xmlurl"]));
      if (url) {
        if (!seen.has(url)) { seen.add(url); feeds.push({ url, title: label, folder }); }
      } else if (raw.outline) {
        walk(raw.outline, folder ? `${folder} / ${label}` : label, depth + 1);
      }
    }
  };
  walk(body.outline, "", 0);
  return feeds;
}

function xmlAttr(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

export function buildOpml(feeds: Array<{ url: string; title: string; siteUrl: string | null; folder: string }>, when = new Date()): string {
  const line = (feed: (typeof feeds)[number], indent: string) =>
    `${indent}<outline type="rss" text="${xmlAttr(feed.title)}" title="${xmlAttr(feed.title)}" xmlUrl="${xmlAttr(feed.url)}"` +
    (feed.siteUrl ? ` htmlUrl="${xmlAttr(feed.siteUrl)}"` : "") + "/>";
  const folders = new Map<string, typeof feeds>();
  for (const feed of feeds) {
    const list = folders.get(feed.folder) ?? [];
    list.push(feed);
    folders.set(feed.folder, list);
  }
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    "    <title>OpenClaw RSS subscriptions</title>",
    `    <dateCreated>${when.toUTCString()}</dateCreated>`,
    "  </head>",
    "  <body>",
  ];
  for (const feed of folders.get("") ?? []) out.push(line(feed, "    "));
  for (const [folder, list] of folders) {
    if (!folder) continue;
    out.push(`    <outline text="${xmlAttr(folder)}" title="${xmlAttr(folder)}">`);
    for (const feed of list) out.push(line(feed, "      "));
    out.push("    </outline>");
  }
  out.push("  </body>", "</opml>", "");
  return out.join("\n");
}
