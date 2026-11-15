import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed, discoverFeedLinks } from "../dist/feed-parse.js";
import { parseOpml, buildOpml } from "../dist/opml.js";
import { cleanHtml, htmlToText } from "../dist/sanitize.js";
import { Store, LIMITS } from "../dist/store.js";
import { Library } from "../dist/library.js";
import { decodeBody } from "../dist/decode.js";
import { safeHttpUrl } from "../dist/text.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Example &amp; Co</title><link>https://example.com/</link><description>d</description>
<item><title><![CDATA[First <b>story</b>]]></title><link>/a/1</link><guid isPermaLink="false">g-1</guid>
<pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><dc:creator>Ann Writer</dc:creator>
<description>&lt;p&gt;Short &amp;amp; sweet&lt;/p&gt;</description>
<content:encoded><![CDATA[<p>Long body about <a href="/x">drones</a>.</p><script>alert(1)</script><img src="/i.png" onerror="x()">]]></content:encoded></item>
<item><title>Second story</title><link>https://example.com/a/2</link>
<pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description>Plain text about elections</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Site</title>
<link rel="self" href="https://atom.example/feed.xml"/><link href="https://atom.example/"/>
<entry><title type="html">Hello &amp;amp; welcome</title><id>tag:atom.example,2026:1</id>
<link rel="alternate" href="https://atom.example/1"/><updated>2026-11-01T08:00:00Z</updated>
<author><name>Bo</name></author>
<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>XHTML <em>body</em></p></div></content></entry>
<entry><title>Text entry</title><id>tag:atom.example,2026:2</id><link href="https://atom.example/2"/>
<published>2026-11-02T08:00:00Z</published><summary type="text">1 &lt; 2 always</summary></entry></feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="https://rdf.example/"><title>RDF Site</title><link>https://rdf.example/</link></channel>
<item rdf:about="https://rdf.example/1"><title>RDF one</title><link>https://rdf.example/1</link>
<dc:date>2026-10-30T12:00:00Z</dc:date><description>RDF body</description></item></rdf:RDF>`;

test("parses RSS 2.0 with CDATA, escaped HTML and relative links", () => {
  const feed = parseFeed(RSS, "https://example.com/feed");
  assert.equal(feed.kind, "rss");
  assert.equal(feed.title, "Example & Co");
  assert.equal(feed.items.length, 2);
  const [first, second] = feed.items;
  assert.equal(first.title, "First story");
  assert.equal(first.url, "https://example.com/a/1");
  assert.equal(first.guid, "g-1");
  assert.equal(first.author, "Ann Writer");
  assert.equal(first.publishedAt, Date.parse("2026-11-02T10:00:00Z"));
  assert.match(first.html, /Long body/);
  assert.equal(second.guid, "https://example.com/a/2");
  assert.equal(second.html, "Plain text about elections");
});

test("parses Atom including XHTML and text content", () => {
  const feed = parseFeed(ATOM, "https://atom.example/feed.xml");
  assert.equal(feed.kind, "atom");
  assert.equal(feed.siteUrl, "https://atom.example/");
  assert.equal(feed.items[0].title, "Hello & welcome");
  assert.equal(feed.items[0].author, "Bo");
  assert.equal(feed.items[0].url, "https://atom.example/1");
  assert.match(cleanHtml(feed.items[0].html), /<p>XHTML <em>body<\/em><\/p>/);
  assert.equal(htmlToText(cleanHtml(feed.items[1].html)), "1 < 2 always");
});

test("parses RSS 1.0 (RDF)", () => {
  const feed = parseFeed(RDF, "https://rdf.example/feed");
  assert.equal(feed.kind, "rdf");
  assert.equal(feed.title, "RDF Site");
  assert.equal(feed.items[0].url, "https://rdf.example/1");
  assert.equal(feed.items[0].publishedAt, Date.parse("2026-10-30T12:00:00Z"));
});

test("rejects documents that are not feeds", () => {
  assert.throws(() => parseFeed("<html><body>hi</body></html>"), /Not a readable feed/);
});

test("discovers feeds advertised by a web page", () => {
  const html = `<head><link rel="stylesheet" href="a.css"><link rel="alternate" type="application/rss+xml" href="/feed.xml">
  <link rel='alternate' type='application/atom+xml' href='https://other.example/atom'></head>`;
  assert.deepEqual(discoverFeedLinks(html, "https://site.example/blog/"), ["https://site.example/feed.xml", "https://other.example/atom"]);
});

test("sanitizer removes active content and resolves links", () => {
  const html = cleanHtml(`<p onclick="x()">Hi <a href="/rel" onmouseover="y()">link</a> <a href="javascript:alert(1)">bad</a></p>
    <script>alert(1)</script><iframe src="https://evil.example"></iframe><style>p{}</style>
    <img src="/pic.png" onerror="z()"><img src="data:image/png;base64,AAAA"><form><input name="q"></form>`, "https://site.example/post/1");
  assert.doesNotMatch(html, /script|iframe|style|onclick|onerror|onmouseover|javascript:|data:|<form|<input/i);
  assert.match(html, /<a target="_blank" rel="noopener noreferrer nofollow" href="https:\/\/site\.example\/rel">link<\/a>/);
  assert.match(html, /<img loading="lazy" referrerpolicy="no-referrer" src="https:\/\/site\.example\/pic\.png" \/>/);
  assert.equal((html.match(/<img/g) ?? []).length, 1);
});

test("URL guard refuses credentials and non-web schemes", () => {
  assert.equal(safeHttpUrl("https://user:pw@example.com/"), null);
  assert.equal(safeHttpUrl("file:///etc/passwd"), null);
  assert.equal(safeHttpUrl("ftp://example.com/"), null);
  assert.equal(safeHttpUrl("/x", "https://example.com/a/"), "https://example.com/x");
});

test("decodes non-UTF-8 feeds from the XML declaration", () => {
  const bytes = Uint8Array.from([...Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><t>caf'), 0xe9, ...Buffer.from("</t>")]);
  assert.match(decodeBody(bytes, "text/xml"), /café/);
});

test("OPML round trip keeps folders", () => {
  const xml = `<opml version="2.0"><body>
    <outline text="News"><outline type="rss" text="A &amp; B" xmlUrl="https://a.example/feed"/>
      <outline text="World"><outline type="rss" title="C" xmlUrl="https://c.example/rss"/></outline></outline>
    <outline type="rss" text="Loose" xmlUrl="https://l.example/atom"/>
    <outline type="rss" text="Dup" xmlUrl="https://l.example/atom"/>
    <outline type="rss" text="Bad" xmlUrl="javascript:alert(1)"/></body></opml>`;
  const feeds = parseOpml(xml);
  assert.deepEqual(feeds, [
    { url: "https://a.example/feed", title: "A & B", folder: "News" },
    { url: "https://c.example/rss", title: "C", folder: "News / World" },
    { url: "https://l.example/atom", title: "Loose", folder: "" },
  ]);
  const again = parseOpml(buildOpml(feeds.map((f) => ({ ...f, siteUrl: null }))));
  const byUrl = (a, b) => a.url.localeCompare(b.url);
  assert.deepEqual(again.sort(byUrl), [...feeds].sort(byUrl), "export lists loose feeds first, so compare regardless of order");
});

function fakeNet(routes) {
  const calls = [];
  const fetch = async ({ url, headers }) => {
    calls.push({ url, headers });
    const route = routes[url];
    if (!route) return { status: 404, headers: new Headers(), body: new Uint8Array(), finalUrl: url };
    const reply = typeof route === "function" ? route(headers) : route;
    return {
      status: reply.status ?? 200,
      headers: new Headers(reply.headers ?? { "content-type": "application/xml; charset=utf-8" }),
      body: new TextEncoder().encode(reply.body ?? ""),
      finalUrl: url,
    };
  };
  return { fetch, calls };
}

test("library: subscribe, read state, saved survival, rules, searches, refresh", async () => {
  const net = fakeNet({
    "https://example.com/": { body: `<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head></html>`, headers: { "content-type": "text/html" } },
    "https://example.com/feed": (headers) => headers["if-none-match"] === '"v1"'
      ? { status: 304 } : { body: RSS, headers: { "content-type": "application/rss+xml", etag: '"v1"' } },
    "https://atom.example/feed.xml": { body: ATOM },
  });
  const events = [];
  const store = new Store(":memory:");
  const library = new Library(store, net.fetch, (reason) => events.push(reason));

  const added = await library.addFeed("example.com", "News");
  assert.equal(added.added, 2);
  assert.equal(added.existed, false);
  assert.equal(store.listFeeds()[0].url, "https://example.com/feed", "followed the page to its advertised feed");
  await library.addFeed("https://atom.example/feed.xml");
  assert.equal((await library.addFeed("https://example.com/feed")).existed, true);
  assert.equal(store.feedCount(), 2);
  assert.ok(events.includes("feed-added"));

  let list = store.listArticles({});
  assert.equal(list.total, 4);
  assert.deepEqual(list.items.map((a) => a.title), ["Second story", "First story", "Text entry", "Hello & welcome"]);
  assert.equal(store.totals().unread, 4);

  // Stored bodies are already sanitized.
  const first = store.getArticle(list.items[1].id);
  assert.doesNotMatch(first.html, /script|onerror/);
  assert.match(first.html, /https:\/\/example\.com\/x/);

  // Search and exclusion are literal and case-insensitive.
  assert.deepEqual(store.listArticles({ search: "DRONES" }).items.map((a) => a.title), ["First story"]);
  assert.equal(store.listArticles({ exclude: "story" }).total, 2);
  assert.equal(store.listArticles({ folder: "News" }).total, 2);

  // Mute rules hide before paging, do not change state, and can be bypassed.
  const feedId = added.feedId;
  const ruleId = store.addRule("Elections", null);
  list = store.listArticles({});
  assert.equal(list.total, 3);
  assert.equal(list.hidden, 1);
  assert.equal(store.listArticles({ showHidden: true }).total, 4);
  assert.equal(store.totals().unread, 4, "unread totals include hidden articles");
  store.removeRule(ruleId);
  store.addRule("elections", 999);
  assert.equal(store.listArticles({}).total, 4, "a rule scoped to another feed does not apply");

  // Read and saved state.
  store.setRead([first.id], true);
  assert.equal(store.listArticles({ view: "unread" }).total, 3);
  store.setSaved(first.id, true);
  assert.equal(store.listArticles({ view: "saved" }).total, 1);
  assert.equal(store.markAllRead(feedId), 1);
  assert.equal(store.markAllRead(), 2);

  // Saved searches remember their filters.
  const searchId = store.addSearch({ name: "", search: "drones", exclude: "", feedId, view: "all", showHidden: false });
  assert.equal(store.listSearches()[0].name, "drones");
  store.removeSearch(searchId);

  // A refresh sends the validator and adds nothing twice.
  const report = await library.refresh();
  assert.deepEqual({ feeds: report.feeds, added: report.added, errors: report.errors.length }, { feeds: 2, added: 0, errors: 0 });
  assert.equal(net.calls.at(-2).headers["if-none-match"] ?? net.calls.at(-1).headers["if-none-match"], '"v1"');
  assert.equal(store.listArticles({ showHidden: true }).total, 4);

  // Unsubscribing keeps the saved story and drops the rest.
  store.removeFeed(feedId);
  const left = store.listArticles({ showHidden: true });
  assert.equal(left.total, 3);
  const kept = left.items.find((a) => a.saved);
  assert.equal(kept.title, "First story");
  assert.equal(kept.feedId, null);
  assert.equal(kept.feedTitle, "Example & Co");
  store.setSaved(kept.id, false);
  assert.equal(store.getArticle(kept.id), null, "an unsaved orphan is removed");
  store.close();
});

test("library: failed feeds are reported and do not stop the others", async () => {
  const net = fakeNet({ "https://atom.example/feed.xml": { body: ATOM } });
  const store = new Store(":memory:");
  const library = new Library(store, net.fetch);
  store.addFeed({ url: "https://gone.example/feed", title: "Gone" });
  store.addFeed({ url: "https://atom.example/feed.xml", title: "" });
  const report = await library.refresh();
  assert.equal(report.added, 2);
  assert.equal(report.errors.length, 1);
  const feeds = store.listFeeds();
  assert.match(feeds.find((f) => f.url.includes("gone")).lastError, /404/);
  assert.equal(feeds.find((f) => f.url.includes("atom")).title, "Atom Site");
  store.close();
});

test("library: history is capped per feed and saved stories survive the cap", () => {
  const store = new Store(":memory:");
  const feedId = store.addFeed({ url: "https://big.example/feed", title: "Big" });
  const batch = (start) => Array.from({ length: 100 }, (_, i) => ({
    guid: `g${start + i}`, url: null, title: `t${start + i}`, author: "", publishedAt: 1_700_000_000_000 + (start + i) * 1000, html: "", text: "",
  }));
  store.addArticles(feedId, batch(0));
  const oldest = store.listArticles({ limit: 100 }).items.at(-1);
  store.setSaved(oldest.id, true);
  for (const start of [100, 200, 300, 400]) store.addArticles(feedId, batch(start));
  assert.equal(store.totals().all, LIMITS.historyPerFeed + 1);
  assert.ok(store.getArticle(oldest.id), "saved story kept beyond the cap");
  store.close();
});

test("library: auto refresh honours the interval and the off switch", async () => {
  const net = fakeNet({ "https://atom.example/feed.xml": { body: ATOM } });
  const store = new Store(":memory:");
  const library = new Library(store, net.fetch);
  store.addFeed({ url: "https://atom.example/feed.xml", title: "" });
  assert.equal(await library.refreshIfDue(), true);
  assert.equal(await library.refreshIfDue(), false, "not due yet");
  assert.equal(await library.refreshIfDue(Date.now() + 31 * 60_000), true);
  store.setSettings({ autoRefresh: false });
  assert.equal(await library.refreshIfDue(Date.now() + 99 * 60 * 60_000), false);
  assert.equal(store.setSettings({ refreshMinutes: 99999 }).refreshMinutes, 1440);
  store.close();
});

test("library: full-article capture stores readable text and records failures", async () => {
  const para = "<p>" + "Readable sentence about the story. ".repeat(20) + "</p>";
  const page = `<html><head><title>T</title></head><body><nav>menu</nav><article><h1>T</h1>${para}${para}<script>bad()</script></article></body></html>`;
  const net = fakeNet({
    "https://example.com/feed": { body: RSS },
    "https://example.com/a/1": { body: page, headers: { "content-type": "text/html; charset=utf-8" } },
  });
  const store = new Store(":memory:");
  const library = new Library(store, net.fetch);
  await library.addFeed("https://example.com/feed");
  const [second, first] = store.listArticles({}).items;
  await library.capture(first.id);
  const full = store.getArticle(first.id);
  assert.equal(full.hasFull, true);
  assert.match(full.fullHtml, /Readable sentence/);
  assert.doesNotMatch(full.fullHtml, /script|bad\(\)/);
  assert.equal(store.listArticles({ search: "readable sentence" }).total, 1, "captured text is searchable");
  await assert.rejects(() => library.capture(second.id), /Could not load the full article/);
  assert.equal(store.getArticle(second.id).fullStatus, "failed");
  store.close();
});

test("library: OPML import skips duplicates and export lists everything", () => {
  const store = new Store(":memory:");
  const library = new Library(store, async () => { throw new Error("no network in this test"); });
  store.addFeed({ url: "https://a.example/feed", title: "A" });
  const result = library.importOpml(`<opml><body><outline text="F"><outline xmlUrl="https://a.example/feed" text="A"/>
    <outline xmlUrl="https://b.example/feed" text="B"/></outline></body></opml>`);
  assert.deepEqual(result, { added: 1, skipped: 1, total: 2 });
  assert.equal(parseOpml(library.exportOpml()).length, 2);
  assert.throws(() => library.importOpml("<nope/>"), /OPML/);
  store.close();
});

test("plain text keeps inline words together and separates blocks", () => {
  assert.equal(htmlToText("<p>This is <em>The Stepback</em>, a <a href='#'>weekly</a> letter.</p><p>Next</p><ul><li>a</li><li>b</li></ul>"),
    "This is The Stepback, a weekly letter. Next a b");
});

test("thumbnails: the feed's declared picture wins, else the first picture in the body", async () => {
  const { parseFeed } = await import("../dist/feed-parse.js");
  const { firstImage } = await import("../dist/store.js");
  const feed = parseFeed(`<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>
    <item><title>A</title><link>https://example.com/a</link><media:thumbnail url="https://example.com/a.jpg"/></item>
    <item><title>B</title><link>https://example.com/b</link><enclosure url="https://example.com/b.mp3" type="audio/mpeg"/></item>
    <item><title>C</title><link>https://example.com/c</link><enclosure url="/c.png" type="image/png"/></item>
  </channel></rss>`, "https://example.com/feed");
  assert.deepEqual(feed.items.map((item) => item.image), ["https://example.com/a.jpg", null, "https://example.com/c.png"]);
  assert.equal(firstImage('<p>x</p><img loading="lazy" src="https://example.com/p.jpg?a=1&amp;b=2" alt="">'), "https://example.com/p.jpg?a=1&b=2");
  assert.equal(firstImage("<p>no pictures</p>"), null);
});

test("search also matches the byline and the publication name", () => {
  const store = new Store(":memory:");
  const feedId = store.addFeed({ url: "https://example.com/feed", title: "Harbor Gazette", folder: "" });
  store.addArticles(feedId, [{ guid: "1", url: "https://example.com/1", title: "Tides", author: "Ana Funte", publishedAt: Date.now(), html: "<p>Water.</p>", text: "Water." }]);
  assert.equal(store.listArticles({ search: "funte" }).total, 1);
  assert.equal(store.listArticles({ search: "harbor gaz" }).total, 1);
  assert.equal(store.listArticles({ search: "nowhere" }).total, 0);
  store.close();
});

test("grading: verdicts are stored once, junk answers are rejected, the article text is never obeyed as an id", async () => {
  const { parseGrades, gradingInstructions } = await import("../dist/library.js");
  assert.deepEqual(parseGrades('```json\n{"grades":[{"id":1,"level":"IMPORTANT","reason":" big  deal "},{"id":9,"level":"spam","reason":"x"},{"id":2,"level":"urgent","reason":"x"},{"id":1,"level":"spam","reason":"dup"}]}\n```', new Set([1, 2])),
    [{ id: 1, level: "important", reason: "big deal" }]);
  assert.deepEqual(parseGrades("sorry, I cannot", new Set([1])), []);
  assert.match(gradingInstructions(""), /important: changes a decision/);
  assert.match(gradingInstructions("important: anything about Iraq"), /anything about Iraq/);

  const store = new Store(":memory:");
  const feedId = store.addFeed({ url: "https://example.com/feed", title: "Feed", folder: "" });
  store.addArticles(feedId, [1, 2, 3].map((n) => ({ guid: String(n), url: `https://example.com/${n}`, title: `Story ${n}`, author: "", publishedAt: Date.now() - n * 1000, html: "<p>t</p>", text: "t" })));
  const calls = [];
  const library = new Library(store, async () => { throw new Error("no network in this test"); }, () => {}, () => {}, async ({ input }) => {
    const items = JSON.parse(input);
    calls.push(items.length);
    return JSON.stringify({ grades: items.map((item, index) => ({ id: item.id, level: index === 0 ? "important" : "normal", reason: "because" })) });
  });
  const first = await library.gradePending({ manual: true });
  assert.deepEqual(first, { graded: 3, remaining: 0 });
  assert.deepEqual(await library.gradePending({ manual: true }), { graded: 0, remaining: 0 });
  assert.deepEqual(calls, [3]);
  const levels = store.listArticles({}).items.map((item) => item.grade?.level);
  assert.deepEqual(levels, ["important", "normal", "normal"]);
  store.clearGrades();
  assert.equal(store.ungradedCount(), 3);

  const broken = new Library(store, async () => { throw new Error("no network"); }, () => {}, () => {}, async () => "not json");
  await assert.rejects(() => broken.gradePending({ manual: true }), /not with grades/);
  assert.equal(broken.gradingStatus().lastError?.includes("not with grades"), true);
  store.close();
});
