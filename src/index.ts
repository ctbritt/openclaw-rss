import path from "node:path";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { contract } from "./contract.js";
import { Library } from "./library.js";
import { guardedFetch } from "./net.js";
import { Store } from "./store.js";

const TICK_MS = 60_000;

export default defineFeaturePlugin({
  contract,
  name: "RSS",
  description: "A reading room for RSS and Atom feeds in the Control UI, with the same library available to the agent.",
  setup(api, events) {
    // Opened on first use so discovery-only loads never create the library file.
    let library: Library | null = null;
    const lib = (): Library => {
      library ??= new Library(
        new Store(process.env.OPENCLAW_RSS_DB ?? path.join(resolveStateDir(), "rss", "library.db")),
        guardedFetch,
        (reason) => { try { events.emit("changed", { reason }); } catch { /* service not started yet */ } },
        (text) => api.logger.info(`[rss] ${text}`),
      );
      return library;
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        await lib().refreshIfDue();
        void lib().drainCaptureQueue();
      } catch (error) {
        api.logger.warn(`[rss] scheduled refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    api.registerService({
      id: "rss-refresh",
      start(ctx) {
        if (ctx.scheduler) {
          ctx.scheduler.schedule({ id: "rss-refresh", delayMs: TICK_MS, everyMs: TICK_MS, run: tick });
        } else {
          timer = setInterval(() => void tick(), TICK_MS);
          timer.unref?.();
        }
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = null;
        library?.store.close();
        library = null;
      },
    });

    const changed = (reason: string) => events.emit("changed", { reason });
    const article = (id: number) => {
      const found = lib().store.getArticle(id);
      if (!found) throw new Error("That article is no longer in the library.");
      return found;
    };

    return {
      overview: () => {
        const store = lib().store;
        const last = store.getMeta("lastRefreshAt");
        return {
          feeds: store.listFeeds(), totals: store.totals(), searches: store.listSearches(), rules: store.listRules(),
          settings: store.getSettings(), lastRefreshAt: last ? Number(last) : null,
        };
      },
      articles: (query) => lib().store.listArticles(query),
      article: ({ id }) => article(id),
      exportOpml: () => ({ xml: lib().exportOpml() }),
      addFeed: ({ url, folder }) => lib().addFeed(url, folder),
      updateFeed: ({ id, title, folder, move }) => {
        lib().store.updateFeed(id, { title, folder });
        if (move) lib().store.moveFeed(id, move);
        changed("feed-updated");
        return { ok: true };
      },
      removeFeed: ({ id }) => { lib().store.removeFeed(id); changed("feed-removed"); return { ok: true }; },
      refresh: ({ feedId }) => lib().refresh(feedId),
      mark: ({ read, ids, feedId, all }) => {
        const store = lib().store;
        let count = 0;
        if (ids?.length) count = store.setRead(ids, read);
        else if (read && feedId !== undefined) count = store.markAllRead(feedId);
        else if (read && all) count = store.markAllRead();
        if (count > 0) changed("read-state");
        return { changed: count };
      },
      save: ({ id, saved }) => { lib().store.setSaved(id, saved); changed("saved-state"); return { ok: true }; },
      capture: async ({ id }) => { await lib().capture(id); return article(id); },
      importOpml: ({ xml }) => lib().importOpml(xml),
      setSettings: (patch) => { const next = lib().store.setSettings(patch); changed("settings"); return next; },
      addRule: ({ phrase, feedId }) => { const id = lib().store.addRule(phrase, feedId ?? null); changed("rules"); return { id }; },
      removeRule: ({ id }) => { lib().store.removeRule(id); changed("rules"); return { ok: true }; },
      addSearch: (search) => { const id = lib().store.addSearch(search); changed("searches"); return { id }; },
      removeSearch: ({ id }) => { lib().store.removeSearch(id); changed("searches"); return { ok: true }; },
    };
  },
});
