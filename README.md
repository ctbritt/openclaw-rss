# OpenClaw RSS

A reading room for RSS and Atom feeds inside the OpenClaw Control UI: subscriptions on the left,
articles in the middle, the story on the right. The library lives on the Gateway machine, and the
agent can read the same library through three tools.

Private project. Modelled feature-for-feature on the community `hermes-rss` plugin for Hermes
Desktop, rebuilt natively for OpenClaw (none of its code is used).

## What it does

- **Read.** RSS 2.0, RSS 1.0 (RDF) and Atom. Add a feed by its address, or give a site address and
  the reader finds the feed the site advertises.
- **Remember.** Read and saved state, folders, manual ordering. Unsubscribing keeps saved stories.
- **Search and mute.** Literal, case-insensitive search and exclusion; saved searches in the
  sidebar; mute rules for all feeds or one. Muted stories are hidden, never deleted.
- **Full articles.** "Load full article" fetches the original page and keeps its readable text.
  Optional background fetching after each refresh (two workers, queue of 80). No paywall bypass.
- **Refresh.** On demand, or automatically every 1 to 1,440 minutes (default 30) while the Gateway
  runs. Feeds that have not changed are not downloaded again.
- **OPML.** Import and export from Settings.
- **Agent in the room.** Summarize, Discuss and Find sources open a conversation with the agent
  beside the article, with the article text attached as material to analyze.
- **Agent tools.** `rss_feeds`, `rss_articles`, `rss_article` (read-only).
- **Keyboard.** `j`/`k` move, `s` save, `m` read/unread, `o` open original, `r` refresh, `/` search.

Limits: 200 feeds, 100 entries per refresh, 300 unsaved stories kept per feed.

## Not built yet (present in hermes-rss)

- Automatic AI grading of new articles with a tunable rubric.
- Inline summaries whose quoted passages are checked against the article text. Today a summary is
  a conversation with the agent, and the quotes are not machine-verified.
- Drag-to-reorder (ordering uses up/down buttons in edit mode).

## Safety

- Publisher HTML is untrusted. It is sanitized on the Gateway before storage and rebuilt from an
  allowlist again in the browser. Scripts, frames, forms, styles and event handlers never render.
- Downloads go through OpenClaw's guarded fetch: private and loopback addresses are refused on
  every redirect, and addresses with embedded credentials are rejected.
- Images are off by default. When on, they load straight from publishers (who then see your IP).
- Article text sent to the agent is labelled as material, not instructions.

## Where things live

| | |
|---|---|
| Library (SQLite) | `~/.openclaw/rss/library.db` on the Gateway machine |
| Engine | `src/library.ts`, `src/store.ts`, `src/feed-parse.ts`, `src/sanitize.ts`, `src/opml.ts` |
| Operations shared by screen and agent | `src/contract.ts`, `src/index.ts` |
| Screen | `src/control-ui.ts`, `src/control-ui.css`, `src/ui/dom.ts` |
| Tests | `test/library.test.mjs` |
| Browser preview without a Gateway | `dev/serve.mjs` |

## Working on it

```sh
npm install
npm test                 # compile + engine tests
npm run build            # compile + bundle the screen
npm run validate
node dev/serve.mjs       # preview at http://127.0.0.1:4173/ with a throwaway library
```

The Gateway runs this folder directly (installed with `openclaw plugins install --link .`).
After a change: `npm run build`, then `openclaw plugins reload rss`. Reload the browser tab if only
the screen changed.

Two things the plugin toolkit enforces that are easy to trip on:

- Operation names must be lowercase (`add_feed`, not `addFeed`).
- Error text thrown by an operation is hidden from the screen. Expected failures are returned as
  `{ error }` results instead (see `attempt` in `src/index.ts`, `unwrap` in `src/control-ui.ts`).

Keep the `openclaw` dev dependency on the same version as the running Gateway; an older copy
refuses to build against a newer state database.
