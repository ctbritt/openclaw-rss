import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { discoverFeedLinks, parseFeed, type ParsedFeed } from "./feed-parse.js";
import { decodeBody } from "./decode.js";
import type { Fetcher } from "./net-types.js";
import { buildOpml, parseOpml } from "./opml.js";
import { cleanHtml, htmlToText } from "./sanitize.js";
import { LIMITS, type NewArticle, type Store } from "./store.js";
import { clip, safeHttpUrl } from "./text.js";

const FEED_BYTES = 4 * 1024 * 1024;
const PAGE_BYTES = 4 * 1024 * 1024;
const FEED_TIMEOUT = 20_000;
const PAGE_TIMEOUT = 25_000;
const REFRESH_WORKERS = 6;
const CAPTURE_WORKERS = 2;
const CAPTURE_QUEUE = 80;

export type RefreshReport = { feeds: number; added: number; errors: Array<{ feedId: number; error: string }> };

function message(error: unknown): string {
  return clip(error instanceof Error ? error.message : String(error), 300);
}

async function pool<T>(items: T[], workers: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

/** Everything the reader does that is not storage: fetching, parsing, capture, import and export. */
export class Library {
  private refreshing: Promise<RefreshReport> | null = null;
  private capturing = false;

  constructor(
    readonly store: Store,
    private readonly fetch: Fetcher,
    private readonly changed: (reason: string) => void = () => {},
    private readonly log: (text: string) => void = () => {},
  ) {
    store.requeueInterrupted();
  }

  private toArticles(feed: ParsedFeed, feedUrl: string): NewArticle[] {
    return feed.items.slice(0, LIMITS.entriesPerRefresh).map((item) => {
      const html = cleanHtml(item.html, item.url ?? feed.siteUrl ?? feedUrl);
      const text = htmlToText(html);
      // An oversized body is kept as text only rather than cut mid-tag.
      const kept = html.length <= LIMITS.feedBodyChars * 4 ? html : `<p>${clip(text, LIMITS.feedBodyChars).replace(/&/gu, "&amp;").replace(/</gu, "&lt;")}</p>`;
      return { guid: item.guid, url: item.url, title: item.title, author: item.author, publishedAt: item.publishedAt, html: kept, text };
    });
  }

  private async download(url: string, conditional?: { etag: string | null; lastModified: string | null }) {
    const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5" };
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;
    const response = await this.fetch({ url, headers, maxBytes: FEED_BYTES, timeoutMs: FEED_TIMEOUT });
    if (response.status === 304) return { notModified: true as const, response };
    if (response.status < 200 || response.status >= 300) throw new Error(`The server answered ${response.status}.`);
    return { notModified: false as const, response, text: decodeBody(response.body, response.headers.get("content-type")) };
  }

  /** Subscribe by feed address, or by a page address that advertises a feed. */
  async addFeed(input: string, folder = ""): Promise<{ feedId: number; title: string; added: number; existed: boolean }> {
    const url = safeHttpUrl(/^[a-z][a-z0-9+.-]*:/iu.test(input.trim()) ? input : `https://${input.trim()}`);
    if (!url) throw new Error("Enter a web address starting with http:// or https://.");
    let feedUrl = url;
    let fetched = await this.download(feedUrl);
    if (fetched.notModified) throw new Error("The server sent no content.");
    let parsed: ParsedFeed;
    try {
      parsed = parseFeed(fetched.text, feedUrl);
    } catch (error) {
      const [advertised] = discoverFeedLinks(fetched.text, fetched.response.finalUrl || feedUrl);
      if (!advertised) throw error;
      feedUrl = advertised;
      fetched = await this.download(feedUrl);
      if (fetched.notModified) throw new Error("The server sent no content.");
      parsed = parseFeed(fetched.text, feedUrl);
    }
    const existing = this.store.findFeedByUrl(feedUrl);
    const feedId = existing ?? this.store.addFeed({ url: feedUrl, title: parsed.title || new URL(feedUrl).hostname, siteUrl: parsed.siteUrl, folder });
    const added = this.store.addArticles(feedId, this.toArticles(parsed, feedUrl));
    this.store.recordFetch(feedId, {
      ok: true, title: parsed.title, siteUrl: parsed.siteUrl,
      etag: fetched.response.headers.get("etag"), lastModified: fetched.response.headers.get("last-modified"),
    });
    this.changed("feed-added");
    this.afterRefresh();
    return { feedId, title: parsed.title || feedUrl, added, existed: existing !== null };
  }

  /** Refresh one feed or all of them. Concurrent callers share the same run. */
  refresh(feedId?: number): Promise<RefreshReport> {
    if (feedId === undefined && this.refreshing) return this.refreshing;
    const run = this.runRefresh(feedId).finally(() => { if (this.refreshing === run) this.refreshing = null; });
    if (feedId === undefined) this.refreshing = run;
    return run;
  }

  private async runRefresh(feedId?: number): Promise<RefreshReport> {
    const states = this.store.fetchStates(feedId);
    const report: RefreshReport = { feeds: states.length, added: 0, errors: [] };
    await pool(states, REFRESH_WORKERS, async (state) => {
      try {
        const fetched = await this.download(state.url, state);
        if (fetched.notModified) {
          this.store.recordFetch(state.id, { ok: true, etag: state.etag, lastModified: state.lastModified });
          return;
        }
        const parsed = parseFeed(fetched.text, state.url);
        report.added += this.store.addArticles(state.id, this.toArticles(parsed, state.url));
        this.store.recordFetch(state.id, {
          ok: true, title: parsed.title, siteUrl: parsed.siteUrl,
          etag: fetched.response.headers.get("etag"), lastModified: fetched.response.headers.get("last-modified"),
        });
      } catch (error) {
        const text = message(error);
        report.errors.push({ feedId: state.id, error: text });
        this.store.recordFetch(state.id, { ok: false, error: text });
      }
    });
    if (feedId === undefined) this.store.setMeta("lastRefreshAt", String(Date.now()));
    this.log(`refresh: ${report.feeds} feeds, ${report.added} new, ${report.errors.length} failed`);
    this.changed("refreshed");
    this.afterRefresh();
    return report;
  }

  /** Called on a timer; refreshes only when the chosen interval has passed. */
  async refreshIfDue(now = Date.now()): Promise<boolean> {
    const settings = this.store.getSettings();
    if (!settings.autoRefresh || this.store.feedCount() === 0) return false;
    const last = Number(this.store.getMeta("lastRefreshAt") ?? 0);
    if (now - last < settings.refreshMinutes * 60_000) return false;
    await this.refresh();
    return true;
  }

  private afterRefresh(): void {
    if (!this.store.getSettings().backgroundCapture) return;
    this.store.queueCapture(CAPTURE_QUEUE);
    void this.drainCaptureQueue();
  }

  /** Background capture: two workers, off the refresh path, resumable after a restart. */
  async drainCaptureQueue(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;
    try {
      await Promise.all(Array.from({ length: CAPTURE_WORKERS }, async () => {
        for (;;) {
          if (!this.store.getSettings().backgroundCapture) return;
          const job = this.store.nextQueued();
          if (!job) return;
          try { await this.capture(job.id, false); } catch { /* recorded as failed */ }
        }
      }));
      this.changed("captured");
    } finally {
      this.capturing = false;
    }
  }

  /** Fetch the original page and keep its readable text. Does not get around paywalls. */
  async capture(id: number, announce = true): Promise<void> {
    const article = this.store.getArticle(id);
    if (!article) throw new Error("That article is no longer in the library.");
    if (!article.url) throw new Error("This article has no link to its original page.");
    try {
      const response = await this.fetch({ url: article.url, headers: { accept: "text/html,application/xhtml+xml" }, maxBytes: PAGE_BYTES, timeoutMs: PAGE_TIMEOUT });
      if (response.status < 200 || response.status >= 300) throw new Error(`The site answered ${response.status}.`);
      const page = decodeBody(response.body, response.headers.get("content-type"));
      const { document } = parseHTML(page);
      const readable = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
      const html = cleanHtml(readable?.content ?? "", response.finalUrl || article.url);
      const text = htmlToText(html);
      if (text.length < 200) throw new Error("No readable article text was found on the page.");
      const kept = text.length <= LIMITS.fullBodyChars ? html : `<p>${clip(text, LIMITS.fullBodyChars).replace(/&/gu, "&amp;").replace(/</gu, "&lt;")}</p>`;
      this.store.setFull(id, { html: kept, text });
    } catch (error) {
      this.store.setFull(id, { failed: true });
      throw new Error(`Could not load the full article: ${message(error)}`);
    } finally {
      if (announce) this.changed("captured");
    }
  }

  /** Add every feed in an OPML file. Nothing is fetched here; the next refresh fills them in. */
  importOpml(xml: string): { added: number; skipped: number; total: number } {
    const feeds = parseOpml(xml);
    let added = 0;
    let skipped = 0;
    for (const feed of feeds) {
      if (this.store.findFeedByUrl(feed.url) !== null || this.store.feedCount() >= LIMITS.feeds) { skipped += 1; continue; }
      this.store.addFeed({ url: feed.url, title: feed.title || new URL(feed.url).hostname, folder: feed.folder });
      added += 1;
    }
    if (added > 0) this.changed("imported");
    return { added, skipped, total: feeds.length };
  }

  exportOpml(): string {
    return buildOpml(this.store.listFeeds());
  }
}
