import sanitizeHtml from "sanitize-html";
import { collapse, decodeEntities, safeHttpUrl } from "./text.js";

const TAGS = [
  "p", "br", "hr", "div", "span", "blockquote", "pre", "code", "kbd", "samp",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd",
  "a", "b", "strong", "i", "em", "u", "s", "del", "ins", "sub", "sup", "small", "mark", "abbr", "cite", "q",
  "figure", "figcaption", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
];

const NON_TEXT = ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "svg", "math", "template"];

/**
 * Publisher HTML is untrusted. Keep reading markup; drop scripts, styles, frames, forms and
 * event handlers; resolve relative links against the article address. Links always open in a
 * new tab without a referrer, and images never send one.
 */
export function cleanHtml(html: string, baseUrl?: string): string {
  const resolve = (value: string | undefined) => (value ? safeHttpUrl(value, baseUrl) : null);
  return sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "loading", "referrerpolicy"],
      th: ["colspan", "rowspan", "scope"],
      td: ["colspan", "rowspan"],
      abbr: ["title"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: NON_TEXT,
    transformTags: {
      a: (tagName, attribs) => {
        const raw = attribs.href;
        const href = raw && /^mailto:/iu.test(raw) ? raw : resolve(raw);
        const next: Record<string, string> = { target: "_blank", rel: "noopener noreferrer nofollow" };
        if (href) next.href = href;
        if (attribs.title) next.title = attribs.title;
        return { tagName, attribs: next };
      },
      img: (tagName, attribs) => {
        const src = resolve(attribs.src || attribs["data-src"]);
        const next: Record<string, string> = { loading: "lazy", referrerpolicy: "no-referrer" };
        if (src) next.src = src;
        if (attribs.alt) next.alt = attribs.alt;
        return { tagName, attribs: next };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  }).trim();
}

/** Plain text for excerpts, search and mute rules. Block boundaries become spaces; inline tags vanish. */
export function htmlToText(html: string): string {
  const spaced = html.replace(/<\/?(p|div|li|ul|ol|h[1-6]|br|hr|tr|td|th|blockquote|figure|figcaption|pre|table)\b[^>]*>/giu, " $& ");
  const stripped = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {}, nonTextTags: NON_TEXT });
  return collapse(decodeEntities(stripped));
}
