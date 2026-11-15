import { Type } from "typebox";
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";

const closed = { additionalProperties: false } as const;
const Id = Type.Integer({ minimum: 1 });
const NullableId = Type.Union([Id, Type.Null()]);
const View = Type.Union([Type.Literal("all"), Type.Literal("unread"), Type.Literal("saved")]);
const Phrase = Type.String({ maxLength: 200 });

const Settings = Type.Object({
  autoRefresh: Type.Boolean(),
  refreshMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
  markReadOnOpen: Type.Boolean(),
  loadImages: Type.Boolean(),
  backgroundCapture: Type.Boolean(),
});

const Feed = Type.Object({
  id: Id, url: Type.String(), title: Type.String(), siteUrl: Type.Union([Type.String(), Type.Null()]),
  folder: Type.String(), position: Type.Integer(), unread: Type.Integer(), total: Type.Integer(),
  lastFetchedAt: Type.Union([Type.Integer(), Type.Null()]), lastError: Type.Union([Type.String(), Type.Null()]),
});

const ArticleSummary = Type.Object({
  id: Id, feedId: NullableId, feedTitle: Type.String(), title: Type.String(), author: Type.String(),
  url: Type.Union([Type.String(), Type.Null()]), publishedAt: Type.Integer(), excerpt: Type.String(),
  read: Type.Boolean(), saved: Type.Boolean(), hasFull: Type.Boolean(),
});

const ArticleDetail = Type.Intersect([ArticleSummary, Type.Object({
  html: Type.String(), fullHtml: Type.Union([Type.String(), Type.Null()]), fullStatus: Type.String(),
})]);

const Rule = Type.Object({ id: Id, phrase: Type.String(), feedId: NullableId });
const SavedSearch = Type.Object({
  id: Id, name: Type.String(), search: Type.String(), exclude: Type.String(), feedId: NullableId,
  view: View, showHidden: Type.Boolean(),
});

const Ok = Type.Object({ ok: Type.Boolean() });
const RefreshReport = Type.Object({
  feeds: Type.Integer(), added: Type.Integer(),
  errors: Type.Array(Type.Object({ feedId: Id, error: Type.String() })),
});

const ArticleQuery = Type.Object({
  feedId: Type.Optional(Id),
  folder: Type.Optional(Type.String({ maxLength: 200 })),
  view: Type.Optional(View),
  search: Type.Optional(Phrase),
  exclude: Type.Optional(Phrase),
  showHidden: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, closed);

export const contract = defineFeatureContract({
  pluginId: "rss",
  operations: {
    overview: {
      kind: "query",
      description: "List subscribed feeds with unread counts, plus saved searches, mute rules and settings.",
      input: Type.Object({}, closed),
      output: Type.Object({
        feeds: Type.Array(Feed),
        totals: Type.Object({ all: Type.Integer(), unread: Type.Integer(), saved: Type.Integer() }),
        searches: Type.Array(SavedSearch),
        rules: Type.Array(Rule),
        settings: Settings,
        lastRefreshAt: Type.Union([Type.Integer(), Type.Null()]),
      }),
      tool: { name: "rss_feeds", label: "List RSS feeds" },
    },
    articles: {
      kind: "query",
      description: "List articles from the RSS library, newest first. Filter by feed, unread or saved, and a search phrase.",
      input: ArticleQuery,
      output: Type.Object({ items: Type.Array(ArticleSummary), total: Type.Integer(), hidden: Type.Integer() }),
      tool: { name: "rss_articles", label: "List RSS articles" },
    },
    article: {
      kind: "query",
      description: "Read one article from the RSS library by id, including its text.",
      input: Type.Object({ id: Id }, closed),
      output: ArticleDetail,
      tool: { name: "rss_article", label: "Read RSS article" },
    },
    exportOpml: {
      kind: "query",
      description: "Export subscriptions as OPML.",
      input: Type.Object({}, closed),
      output: Type.Object({ xml: Type.String() }),
    },
    addFeed: {
      kind: "action",
      description: "Subscribe to a feed by its address, or by a page that advertises one.",
      input: Type.Object({ url: Type.String({ minLength: 1, maxLength: 2000 }), folder: Type.Optional(Type.String({ maxLength: 200 })) }, closed),
      output: Type.Object({ feedId: Id, title: Type.String(), added: Type.Integer(), existed: Type.Boolean() }),
    },
    updateFeed: {
      kind: "action",
      description: "Rename a feed, move it to a folder, or reorder it.",
      input: Type.Object({
        id: Id, title: Type.Optional(Type.String({ maxLength: 200 })), folder: Type.Optional(Type.String({ maxLength: 200 })),
        move: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
      }, closed),
      output: Ok,
    },
    removeFeed: {
      kind: "action",
      description: "Unsubscribe from a feed. Saved stories are kept.",
      input: Type.Object({ id: Id }, closed),
      output: Ok,
    },
    refresh: {
      kind: "action",
      description: "Fetch new articles for one feed or all feeds.",
      input: Type.Object({ feedId: Type.Optional(Id) }, closed),
      output: RefreshReport,
    },
    mark: {
      kind: "action",
      description: "Mark articles read or unread: specific ids, one feed, or everything.",
      input: Type.Object({
        read: Type.Boolean(),
        ids: Type.Optional(Type.Array(Id, { maxItems: 500 })),
        feedId: Type.Optional(Id),
        all: Type.Optional(Type.Boolean()),
      }, closed),
      output: Type.Object({ changed: Type.Integer() }),
    },
    save: {
      kind: "action",
      description: "Save or unsave an article.",
      input: Type.Object({ id: Id, saved: Type.Boolean() }, closed),
      output: Ok,
    },
    capture: {
      kind: "action",
      description: "Load the readable text of an article from its original page.",
      input: Type.Object({ id: Id }, closed),
      output: ArticleDetail,
    },
    importOpml: {
      kind: "action",
      description: "Import subscriptions from OPML.",
      input: Type.Object({ xml: Type.String({ minLength: 1, maxLength: 2_000_000 }) }, closed),
      output: Type.Object({ added: Type.Integer(), skipped: Type.Integer(), total: Type.Integer() }),
    },
    setSettings: {
      kind: "action",
      description: "Change reader settings.",
      input: Type.Partial(Settings, closed),
      output: Settings,
    },
    addRule: {
      kind: "action",
      description: "Add a mute rule: hide articles containing a phrase, in all feeds or one.",
      input: Type.Object({ phrase: Type.String({ minLength: 1, maxLength: 200 }), feedId: Type.Optional(NullableId) }, closed),
      output: Type.Object({ id: Id }),
    },
    removeRule: {
      kind: "action",
      description: "Remove a mute rule.",
      input: Type.Object({ id: Id }, closed),
      output: Ok,
    },
    addSearch: {
      kind: "action",
      description: "Save the current search and filters under a name.",
      input: Type.Object({
        name: Type.String({ maxLength: 100 }), search: Phrase, exclude: Phrase, feedId: NullableId,
        view: View, showHidden: Type.Boolean(),
      }, closed),
      output: Type.Object({ id: Id }),
    },
    removeSearch: {
      kind: "action",
      description: "Remove a saved search.",
      input: Type.Object({ id: Id }, closed),
      output: Ok,
    },
  },
  events: {
    changed: Type.Object({ reason: Type.String() }),
  },
});
