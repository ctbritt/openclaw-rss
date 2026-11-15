# RSS for OpenClaw

A native, theme-aware RSS and Atom reader for the OpenClaw Control UI, with optional AI importance grading.

## Features

- Three-pane reader with subscriptions, folders, unread counts, saved articles, and keyboard navigation.
- RSS 2.0, RSS 1.0/RDF, and Atom feeds, including feed discovery from a website address.
- Case-insensitive search, exclusions, saved searches, and mute rules. Muting hides articles rather than deleting them.
- Full-text extraction and a button that switches between the full article and the feed summary. Optional background extraction does not bypass paywalls.
- Automatic refresh every 30 minutes by default, configurable from 1 to 1,440 minutes, with conditional HTTP requests.
- OPML import and export. Unsubscribing preserves saved articles.
- Summarize, Discuss, and Find sources actions open an agent conversation with article context.
- Optional importance grading: Important, Interesting, Normal, or Spam; built-in Important, Interesting, and Hide spam filters; a configurable rubric and model selector.
- OpenClaw’s configured decision model can grade without generating a written reason.

Keyboard shortcuts: **j/k** move between articles, **s** saves, **m** toggles read state, **o** opens the original, **r** refreshes, and **/** searches.

## Requirements and installation

Requires OpenClaw **2026.11.3 or later** and its supported Node.js runtime.

Install from ClawHub:

```sh
openclaw plugins install clawhub:@ctbritt/openclaw-rss
```

Or build from source:

```sh
git clone https://github.com/ctbritt/openclaw-rss.git
cd openclaw-rss
npm install
npm test
npm run build
npm run validate
openclaw plugins install --link .
```

The repository may require GitHub access before public release. Open RSS in the Control UI sidebar, add a feed or import OPML, and configure reading and grading preferences in Settings.

## Data, models, and privacy

The library is stored locally in `~/.openclaw/rss/library.db`. Article fetching contacts publishers’ websites. Images are off by default; displaying publisher-hosted images makes requests to those publishers, exposing the requesting device’s IP address.

AI grading is optional. The selected model receives article text for grading. Local models keep inference local; cloud providers receive that text and may charge for usage. The decision-model option uses the decision provider configured in OpenClaw—it is not necessarily local. Agent conversation actions use the conversation’s configured model.

## Agent tools

Three read-only tools expose the same library:

- `rss_feeds`: subscriptions, folders, unread counts, and settings.
- `rss_articles`: article lists with search and grade filters.
- `rss_article`: one article’s text and metadata.

## Safety and limits

Article HTML is sanitized to remove scripts, frames, forms, styles, event handlers, and other active content. Network fetching rejects private and loopback destinations, embedded credentials, and unsafe redirects. Article content is untrusted input, including during grading.

The reader limits subscriptions to 200 feeds, processes up to 100 entries per feed refresh, and retains up to 300 unsaved articles per feed. Background full-text extraction uses two workers and a bounded queue of 80 articles.

## Current limitations

- Conversation summaries are not machine-checked against article quotations; there are no quote-verified inline summaries.
- Feed ordering uses up/down controls, not drag-and-drop.
- Grading quality depends on the selected model and rubric. No model-quality benchmark is claimed for this release.

## Development

The build pins OpenClaw 2026.11.3 so releases stay compatible with stable. If your installed OpenClaw is newer, the pinned CLI may refuse your state database; build against an empty one instead:

```sh
mkdir -p /tmp/rss-build && echo '{}' > /tmp/rss-build/openclaw.json
OPENCLAW_STATE_DIR=/tmp/rss-build OPENCLAW_CONFIG_PATH=/tmp/rss-build/openclaw.json npm run build
```

```sh
npm test
npm run build
npm run validate
npm run pack
```

`src/library.ts` coordinates the library; `src/store.ts` stores it; `src/feed-parse.ts`, `src/sanitize.ts`, and `src/opml.ts` handle input. `src/index.ts` registers the plugin, `src/contract.ts` defines shared contracts, and `src/control-ui.ts` / CSS implement the reader. Tests live in `test/`.

`node dev/serve.mjs` provides a local preview on port 4173 with a separate development library.

## License

MIT. See [LICENSE](LICENSE). Release notes are in [CHANGELOG.md](CHANGELOG.md).
