/** Decode using the charset from the header, the XML prolog or an HTML meta tag; UTF-8 otherwise. */
export function decodeBody(body: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 2048));
  const declared =
    /charset\s*=\s*"?([\w.:-]+)/iu.exec(contentType ?? "")?.[1] ??
    /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/iu.exec(head)?.[1] ??
    /<meta[^>]*charset\s*=\s*["']?([\w.:-]+)/iu.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(declared.toLowerCase()).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
