// Small text helpers shared by the parser, the store and the sanitizer.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©",
};

/** Decode one level of HTML/XML entities. Unknown named entities are left as written. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/giu, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

export function escapeHtml(input: string): string {
  return input.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

export function collapse(input: string): string {
  return input.replace(/\s+/gu, " ").trim();
}

export function clip(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, max - 1).trimEnd() + "…";
}

/** http(s) only, no embedded credentials. Returns the normalized URL or null. */
export function safeHttpUrl(input: string, base?: string): string | null {
  try {
    const url = base ? new URL(input.trim(), base) : new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
