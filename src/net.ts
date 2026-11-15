import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

import type { Fetcher } from "./net-types.js";

const USER_AGENT = "OpenClaw-RSS/0.1 (feed reader)";

/**
 * Download through the host's guarded fetch: private-network addresses are refused on every
 * redirect hop, and the body is cut off at a byte ceiling.
 */
export const guardedFetch: Fetcher = async ({ url, headers, maxBytes, timeoutMs }) => {
  const { response, finalUrl, release } = await fetchWithSsrFGuard({
    url,
    init: { method: "GET", headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers }, redirect: "manual" },
    maxRedirects: 5,
    timeoutMs,
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body && response.status !== 304) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`Response is larger than ${Math.round(maxBytes / 1024)} KB.`);
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return { status: response.status, headers: response.headers, body, finalUrl };
  } finally {
    await release();
  }
};
