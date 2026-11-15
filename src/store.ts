import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clip } from "./text.js";

export const LIMITS = {
  feeds: 200,
  entriesPerRefresh: 100,
  historyPerFeed: 300,
  feedBodyChars: 24_000,
  fullBodyChars: 60_000,
  excerptChars: 280,
  pageSize: 100,
} as const;

export type Settings = {
  autoRefresh: boolean;
  refreshMinutes: number;
  markReadOnOpen: boolean;
  loadImages: boolean;
  backgroundCapture: boolean;
  aiGrading: boolean;
  /** The reader's own words on what matters; empty means the built-in rubric. */
  gradingRubric: string;
  /** Model to grade with, as provider/model; empty means whatever OpenClaw gives the plugin by default. */
  gradingModel: string;
};

export const GRADE_LEVELS = ["important", "interesting", "normal", "spam"] as const;
export type GradeLevel = (typeof GRADE_LEVELS)[number];
export type Grade = { level: GradeLevel; reason: string };

export const DEFAULT_SETTINGS: Settings = {
  autoRefresh: true,
  refreshMinutes: 30,
  markReadOnOpen: true,
  loadImages: true,
  backgroundCapture: true,
  aiGrading: true,
  gradingRubric: "",
  gradingModel: "",
};

export type FeedRow = {
  id: number; url: string; title: string; siteUrl: string | null; folder: string; position: number;
  unread: number; total: number; lastFetchedAt: number | null; lastError: string | null;
};

export type FeedFetchState = { id: number; url: string; etag: string | null; lastModified: string | null };

export type ArticleSummary = {
  id: number; feedId: number | null; feedTitle: string; title: string; author: string; url: string | null;
  publishedAt: number; excerpt: string; image: string | null; read: boolean; saved: boolean; hasFull: boolean;
  /** Null until graded. "normal" is stored too, so a story is never graded twice. */
  grade: Grade | null;
};

export type ArticleDetail = ArticleSummary & { html: string; fullHtml: string | null; fullStatus: string };

export type Rule = { id: number; phrase: string; feedId: number | null };
export type SavedSearch = {
  id: number; name: string; search: string; exclude: string; feedId: number | null;
  view: View; showHidden: boolean;
};
export type View = "all" | "unread" | "saved";

export type ArticleQuery = {
  feedId?: number; folder?: string; view?: View; search?: string; exclude?: string;
  showHidden?: boolean; offset?: number; limit?: number;
  /** Only stories graded at one of these levels. */
  grades?: GradeLevel[];
  /** Leave out stories graded as spam (ungraded stories stay). */
  hideSpam?: boolean;
};

export type NewArticle = {
  guid: string; url: string | null; title: string; author: string; publishedAt: number | null;
  html: string; text: string; image?: string | null;
};

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', custom_title TEXT,
  site_url TEXT, folder TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
  etag TEXT, last_modified TEXT, last_fetched_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY, feed_id INTEGER, feed_title TEXT NOT NULL DEFAULT '', guid TEXT NOT NULL,
  url TEXT, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL, excerpt TEXT NOT NULL DEFAULT '', html TEXT NOT NULL DEFAULT '', image TEXT,
  grade TEXT, grade_reason TEXT,
  search_lc TEXT NOT NULL DEFAULT '', full_html TEXT, full_status TEXT NOT NULL DEFAULT 'none',
  read INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0,
  UNIQUE (feed_id, guid)
);
CREATE INDEX IF NOT EXISTS articles_feed_time ON articles (feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS articles_time ON articles (published_at DESC);
CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY, phrase TEXT NOT NULL, feed_id INTEGER);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, search TEXT NOT NULL DEFAULT '', exclude TEXT NOT NULL DEFAULT '',
  feed_id INTEGER, view TEXT NOT NULL DEFAULT 'all', show_hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const HIDDEN = `EXISTS (SELECT 1 FROM rules r WHERE (r.feed_id IS NULL OR r.feed_id = a.feed_id) AND instr(a.search_lc, lower(r.phrase)) > 0)`;
const SUMMARY_COLUMNS = `a.id, a.feed_id, COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), a.feed_title) AS feed_title,
  a.title, a.author, a.url, a.published_at, a.excerpt, a.image, a.read, a.saved, a.full_status, a.grade, a.grade_reason`;

/** First picture in already-cleaned article HTML, used as the list thumbnail when the feed names none. */
export function firstImage(html: string): string | null {
  const src = /<img\b[^>]*?\ssrc="(https?:\/\/[^"]+)"/iu.exec(html)?.[1];
  return src ? src.replace(/&amp;/gu, "&").slice(0, 2000) : null;
}

function summary(row: Row): ArticleSummary {
  return {
    id: Number(row.id),
    feedId: row.feed_id === null ? null : Number(row.feed_id),
    feedTitle: String(row.feed_title ?? ""),
    title: String(row.title),
    author: String(row.author ?? ""),
    url: row.url === null ? null : String(row.url),
    publishedAt: Number(row.published_at),
    excerpt: String(row.excerpt ?? ""),
    image: row.image === null || row.image === undefined ? null : String(row.image),
    read: Number(row.read) === 1,
    saved: Number(row.saved) === 1,
    hasFull: row.full_status === "done",
    grade: (GRADE_LEVELS as readonly string[]).includes(String(row.grade)) ? { level: String(row.grade) as GradeLevel, reason: String(row.grade_reason ?? "") } : null,
  };
}

/** The local reading library: subscriptions, articles, read/saved state, rules, searches, settings. */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 4000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Bring libraries created by earlier versions up to date. */
  private migrate(): void {
    const columns = (this.db.prepare("PRAGMA table_info(articles)").all() as Row[]).map((row) => String(row.name));
    if (!columns.includes("image")) {
      this.tx(() => {
        this.db.exec("ALTER TABLE articles ADD COLUMN image TEXT");
        const update = this.db.prepare("UPDATE articles SET image = ? WHERE id = ?");
        for (const row of this.db.prepare("SELECT id, html FROM articles WHERE html LIKE '%<img%'").all() as Row[]) {
          const image = firstImage(String(row.html));
          if (image) update.run(image, Number(row.id));
        }
      });
    }
    if (!columns.includes("grade")) this.db.exec("ALTER TABLE articles ADD COLUMN grade TEXT; ALTER TABLE articles ADD COLUMN grade_reason TEXT;");
  }

  // ---- grading --------------------------------------------------------------------------

  /** Newest stories that have no grade yet. */
  ungraded(limit: number): Array<{ id: number; title: string; feedTitle: string; excerpt: string }> {
    return (this.db.prepare(`SELECT a.id, a.title, a.excerpt, COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), a.feed_title) AS feed_title
      FROM articles a LEFT JOIN feeds f ON f.id = a.feed_id WHERE a.grade IS NULL ORDER BY a.published_at DESC, a.id DESC LIMIT ?`).all(limit) as Row[])
      .map((row) => ({ id: Number(row.id), title: String(row.title), feedTitle: String(row.feed_title ?? ""), excerpt: String(row.excerpt ?? "") }));
  }

  ungradedCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE grade IS NULL").get() as Row).n);
  }

  setGrades(grades: Array<{ id: number } & Grade>): number {
    return this.tx(() => {
      const update = this.db.prepare("UPDATE articles SET grade = ?, grade_reason = ? WHERE id = ?");
      let count = 0;
      for (const grade of grades) count += Number(update.run(grade.level, clip(grade.reason, 240), grade.id).changes);
      return count;
    });
  }

  /** Forget every grade, so the next pass starts over (used after the rubric changes). */
  clearGrades(): void {
    this.db.exec("UPDATE articles SET grade = NULL, grade_reason = NULL");
  }

  close(): void { this.db.close(); }

  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // ---- settings -------------------------------------------------------------------------

  getSettings(): Settings {
    const settings: Settings = { ...DEFAULT_SETTINGS };
    for (const row of this.db.prepare("SELECT key, value FROM settings").all() as Row[]) {
      const key = String(row.key) as keyof Settings;
      if (!(key in settings)) continue;
      try { (settings as Record<string, unknown>)[key] = JSON.parse(String(row.value)); } catch { /* keep default */ }
    }
    settings.gradingModel = clip(String(settings.gradingModel ?? "").trim(), 200);
    settings.gradingRubric = clip(String(settings.gradingRubric ?? ""), 4000);
    settings.refreshMinutes = Math.min(1440, Math.max(1, Math.round(Number(settings.refreshMinutes) || DEFAULT_SETTINGS.refreshMinutes)));
    return settings;
  }

  setSettings(patch: Partial<Settings>): Settings {
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && key in DEFAULT_SETTINGS) put.run(key, JSON.stringify(value));
    }
    return this.getSettings();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(`meta:${key}`) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`meta:${key}`, value);
  }

  // ---- feeds ----------------------------------------------------------------------------

  listFeeds(): FeedRow[] {
    const rows = this.db.prepare(`
      SELECT f.id, f.url, COALESCE(NULLIF(f.custom_title, ''), NULLIF(f.title, ''), f.url) AS title, f.site_url, f.folder,
             f.position, f.last_fetched_at, f.last_error,
             (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND a.read = 0) AS unread,
             (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id) AS total
      FROM feeds f ORDER BY f.folder COLLATE NOCASE, f.position, f.id`).all() as Row[];
    return rows.map((row) => ({
      id: Number(row.id), url: String(row.url), title: String(row.title),
      siteUrl: row.site_url === null ? null : String(row.site_url), folder: String(row.folder),
      position: Number(row.position), unread: Number(row.unread), total: Number(row.total),
      lastFetchedAt: row.last_fetched_at === null ? null : Number(row.last_fetched_at),
      lastError: row.last_error === null ? null : String(row.last_error),
    }));
  }

  feedCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM feeds").get() as Row).n);
  }

  findFeedByUrl(url: string): number | null {
    const row = this.db.prepare("SELECT id FROM feeds WHERE url = ?").get(url) as Row | undefined;
    return row ? Number(row.id) : null;
  }

  addFeed(feed: { url: string; title: string; siteUrl?: string | null; folder?: string }, now = Date.now()): number {
    if (this.feedCount() >= LIMITS.feeds) throw new Error(`The library holds at most ${LIMITS.feeds} feeds.`);
    const position = Number((this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM feeds").get() as Row).p);
    const result = this.db.prepare("INSERT INTO feeds (url, title, site_url, folder, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(feed.url, feed.title, feed.siteUrl ?? null, (feed.folder ?? "").trim(), position, now);
    return Number(result.lastInsertRowid);
  }

  updateFeed(id: number, patch: { title?: string; folder?: string }): void {
    if (patch.title !== undefined) this.db.prepare("UPDATE feeds SET custom_title = ? WHERE id = ?").run(patch.title.trim() || null, id);
    if (patch.folder !== undefined) this.db.prepare("UPDATE feeds SET folder = ? WHERE id = ?").run(patch.folder.trim(), id);
  }

  /** Move a feed one step among its folder siblings. */
  moveFeed(id: number, direction: "up" | "down"): void {
    this.tx(() => {
      const me = this.db.prepare("SELECT folder FROM feeds WHERE id = ?").get(id) as Row | undefined;
      if (!me) return;
      const siblings = (this.db.prepare("SELECT id FROM feeds WHERE folder = ? ORDER BY position, id").all(String(me.folder)) as Row[]).map((row) => Number(row.id));
      const index = siblings.indexOf(id);
      const swap = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || swap < 0 || swap >= siblings.length) return;
      [siblings[index], siblings[swap]] = [siblings[swap]!, siblings[index]!];
      const set = this.db.prepare("UPDATE feeds SET position = ? WHERE id = ?");
      siblings.forEach((feedId, order) => set.run(order + 1, feedId));
    });
  }

  /** Unsubscribe. Saved stories survive, detached from the feed; everything else from it goes. */
  removeFeed(id: number): void {
    this.tx(() => {
      const row = this.db.prepare("SELECT COALESCE(NULLIF(custom_title, ''), NULLIF(title, ''), url) AS title FROM feeds WHERE id = ?").get(id) as Row | undefined;
      if (!row) return;
      this.db.prepare("DELETE FROM articles WHERE feed_id = ? AND saved = 0").run(id);
      // A detached story keeps a unique guid so two feeds' leftovers cannot collide.
      this.db.prepare("UPDATE articles SET feed_title = ?, guid = 'detached:' || id || ':' || guid, feed_id = NULL WHERE feed_id = ?").run(String(row.title), id);
      this.db.prepare("DELETE FROM rules WHERE feed_id = ?").run(id);
      this.db.prepare("UPDATE searches SET feed_id = NULL WHERE feed_id = ?").run(id);
      this.db.prepare("DELETE FROM feeds WHERE id = ?").run(id);
    });
  }

  fetchStates(feedId?: number): FeedFetchState[] {
    const rows = (feedId === undefined
      ? this.db.prepare("SELECT id, url, etag, last_modified FROM feeds ORDER BY id").all()
      : this.db.prepare("SELECT id, url, etag, last_modified FROM feeds WHERE id = ?").all(feedId)) as Row[];
    return rows.map((row) => ({
      id: Number(row.id), url: String(row.url),
      etag: row.etag === null ? null : String(row.etag),
      lastModified: row.last_modified === null ? null : String(row.last_modified),
    }));
  }

  recordFetch(id: number, result: { ok: true; title?: string; siteUrl?: string | null; etag?: string | null; lastModified?: string | null } | { ok: false; error: string }, now = Date.now()): void {
    if (result.ok) {
      this.db.prepare(`UPDATE feeds SET last_fetched_at = ?, last_error = NULL,
        title = COALESCE(NULLIF(?, ''), title), site_url = COALESCE(?, site_url), etag = ?, last_modified = ? WHERE id = ?`)
        .run(now, result.title ?? "", result.siteUrl ?? null, result.etag ?? null, result.lastModified ?? null, id);
    } else {
      this.db.prepare("UPDATE feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?").run(now, clip(result.error, 300), id);
    }
  }

  // ---- articles -------------------------------------------------------------------------

  /** Insert unseen entries and trim old unsaved history. Returns how many were new. */
  addArticles(feedId: number, items: NewArticle[], now = Date.now()): number {
    return this.tx(() => {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO articles
        (feed_id, guid, url, title, author, published_at, fetched_at, excerpt, html, search_lc, image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let added = 0;
      for (const item of items.slice(0, LIMITS.entriesPerRefresh)) {
        // A missing or future-dated timestamp would pin the story to the top forever.
        const published = item.publishedAt !== null && item.publishedAt <= now + 86_400_000 ? item.publishedAt : now;
        const body = clip(item.text, LIMITS.feedBodyChars);
        const result = insert.run(feedId, item.guid, item.url, clip(item.title, 500), clip(item.author, 200), published, now,
          clip(body, LIMITS.excerptChars), item.html, `${item.title}\n${body}`.toLowerCase(), item.image ?? null);
        added += Number(result.changes);
      }
      this.db.prepare(`DELETE FROM articles WHERE feed_id = ? AND saved = 0 AND id NOT IN (
        SELECT id FROM articles WHERE feed_id = ? AND saved = 0 ORDER BY published_at DESC, id DESC LIMIT ?)`)
        .run(feedId, feedId, LIMITS.historyPerFeed);
      return added;
    });
  }

  private where(query: ArticleQuery): { sql: string; params: Array<string | number> } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.feedId !== undefined) { clauses.push("a.feed_id = ?"); params.push(query.feedId); }
    else if (query.folder !== undefined) { clauses.push("a.feed_id IN (SELECT id FROM feeds WHERE folder = ?)"); params.push(query.folder); }
    if (query.view === "unread") clauses.push("a.read = 0");
    if (query.view === "saved") clauses.push("a.saved = 1");
    const grades = (query.grades ?? []).filter((level) => (GRADE_LEVELS as readonly string[]).includes(level));
    if (grades.length) { clauses.push(`a.grade IN (${grades.map(() => "?").join(", ")})`); params.push(...grades); }
    if (query.hideSpam) clauses.push("(a.grade IS NULL OR a.grade <> 'spam')");
    const search = query.search?.trim().toLowerCase();
    // Headline and text, plus the byline and the publication's name.
    if (search) {
      clauses.push(`(instr(a.search_lc, ?) > 0 OR instr(lower(a.author), ?) > 0
        OR instr(lower(COALESCE((SELECT COALESCE(NULLIF(f2.custom_title, ''), f2.title) FROM feeds f2 WHERE f2.id = a.feed_id), a.feed_title)), ?) > 0)`);
      params.push(search, search, search);
    }
    const exclude = query.exclude?.trim().toLowerCase();
    if (exclude) { clauses.push("instr(a.search_lc, ?) = 0"); params.push(exclude); }
    return { sql: clauses.length ? clauses.join(" AND ") : "1 = 1", params };
  }

  /** Mute rules hide matches before paging; search and exclusion always apply. */
  listArticles(query: ArticleQuery): { items: ArticleSummary[]; total: number; hidden: number } {
    const { sql, params } = this.where(query);
    const visible = query.showHidden ? sql : `${sql} AND NOT ${HIDDEN}`;
    const limit = Math.min(LIMITS.pageSize, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const rows = this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM articles a LEFT JOIN feeds f ON f.id = a.feed_id
      WHERE ${visible} ORDER BY a.published_at DESC, a.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Row[];
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM articles a WHERE ${visible}`).get(...params) as Row).n);
    const hidden = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM articles a WHERE ${sql} AND ${HIDDEN}`).get(...params) as Row).n);
    return { items: rows.map(summary), total, hidden };
  }

  getArticle(id: number): ArticleDetail | null {
    const row = this.db.prepare(`SELECT ${SUMMARY_COLUMNS}, a.html, a.full_html FROM articles a
      LEFT JOIN feeds f ON f.id = a.feed_id WHERE a.id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    return { ...summary(row), html: String(row.html ?? ""), fullHtml: row.full_html === null ? null : String(row.full_html), fullStatus: String(row.full_status) };
  }

  totals(): { all: number; unread: number; saved: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(read = 0), 0) AS unread, COALESCE(SUM(saved), 0) AS saved FROM articles").get() as Row;
    return { all: Number(row.n), unread: Number(row.unread), saved: Number(row.saved) };
  }

  setRead(ids: number[], read: boolean): number {
    const set = this.db.prepare("UPDATE articles SET read = ? WHERE id = ?");
    return this.tx(() => ids.reduce((sum, id) => sum + Number(set.run(read ? 1 : 0, id).changes), 0));
  }

  /** Mark a whole feed, or the whole library, read. Hidden stories are included by design. */
  markAllRead(feedId?: number): number {
    const result = feedId === undefined
      ? this.db.prepare("UPDATE articles SET read = 1 WHERE read = 0").run()
      : this.db.prepare("UPDATE articles SET read = 1 WHERE read = 0 AND feed_id = ?").run(feedId);
    return Number(result.changes);
  }

  setSaved(id: number, saved: boolean): void {
    this.db.prepare("UPDATE articles SET saved = ? WHERE id = ?").run(saved ? 1 : 0, id);
    // A detached story that is no longer saved has no feed to belong to.
    if (!saved) this.db.prepare("DELETE FROM articles WHERE id = ? AND feed_id IS NULL").run(id);
  }

  setFull(id: number, result: { html: string; text: string } | { failed: true }): void {
    if ("failed" in result) {
      this.db.prepare("UPDATE articles SET full_status = 'failed' WHERE id = ?").run(id);
      return;
    }
    this.db.prepare(`UPDATE articles SET full_html = ?, full_status = 'done',
      search_lc = lower(title) || char(10) || ? WHERE id = ?`).run(result.html, clip(result.text, LIMITS.fullBodyChars).toLowerCase(), id);
  }

  /** Queue the newest uncaptured stories, never holding more than `max` in the queue. */
  queueCapture(max: number): void {
    const queued = Number((this.db.prepare("SELECT COUNT(*) AS n FROM articles WHERE full_status IN ('queued', 'working')").get() as Row).n);
    const room = Math.max(0, max - queued);
    if (room === 0) return;
    this.db.prepare(`UPDATE articles SET full_status = 'queued' WHERE id IN (
      SELECT id FROM articles WHERE full_status = 'none' AND url IS NOT NULL ORDER BY published_at DESC LIMIT ?)`).run(room);
  }

  nextQueued(): { id: number; url: string } | null {
    const row = this.db.prepare("SELECT id, url FROM articles WHERE full_status = 'queued' AND url IS NOT NULL ORDER BY published_at DESC LIMIT 1").get() as Row | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE articles SET full_status = 'working' WHERE id = ?").run(Number(row.id));
    return { id: Number(row.id), url: String(row.url) };
  }

  /** Work interrupted by a restart goes back in the queue. */
  requeueInterrupted(): void {
    this.db.exec("UPDATE articles SET full_status = 'queued' WHERE full_status = 'working'");
  }

  // ---- rules and saved searches ---------------------------------------------------------

  listRules(): Rule[] {
    return (this.db.prepare("SELECT id, phrase, feed_id FROM rules ORDER BY id").all() as Row[])
      .map((row) => ({ id: Number(row.id), phrase: String(row.phrase), feedId: row.feed_id === null ? null : Number(row.feed_id) }));
  }

  addRule(phrase: string, feedId: number | null): number {
    const clean = phrase.trim();
    if (!clean) throw new Error("A mute rule needs a phrase.");
    return Number(this.db.prepare("INSERT INTO rules (phrase, feed_id) VALUES (?, ?)").run(clean, feedId).lastInsertRowid);
  }

  removeRule(id: number): void { this.db.prepare("DELETE FROM rules WHERE id = ?").run(id); }

  listSearches(): SavedSearch[] {
    return (this.db.prepare("SELECT * FROM searches ORDER BY name COLLATE NOCASE, id").all() as Row[]).map((row) => ({
      id: Number(row.id), name: String(row.name), search: String(row.search), exclude: String(row.exclude),
      feedId: row.feed_id === null ? null : Number(row.feed_id),
      view: (["all", "unread", "saved"].includes(String(row.view)) ? String(row.view) : "all") as View,
      showHidden: Number(row.show_hidden) === 1,
    }));
  }

  addSearch(search: Omit<SavedSearch, "id">): number {
    const name = search.name.trim() || search.search.trim() || "Saved search";
    return Number(this.db.prepare("INSERT INTO searches (name, search, exclude, feed_id, view, show_hidden) VALUES (?, ?, ?, ?, ?, ?)")
      .run(name, search.search.trim(), search.exclude.trim(), search.feedId, search.view, search.showHidden ? 1 : 0).lastInsertRowid);
  }

  removeSearch(id: number): void { this.db.prepare("DELETE FROM searches WHERE id = ?").run(id); }
}
