import path from "node:path";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { contract } from "./contract.js";
import { articleForWire, Library } from "./library.js";
import { guardedFetch } from "./net.js";
import { Store } from "./store.js";

const TICK_MS = 60_000;

export default defineFeaturePlugin({
  contract,
  name: "RSS",
  description: "A reading room for RSS and Atom feeds in the Control UI, with the same library available to the agent.",
  setup(api, events) {
    // Announcing a change must never fail the change itself (the emitter is only live while the Gateway service runs).
    const changed = (reason: string) => { try { events.emit("changed", { reason }); } catch { /* no listeners yet */ } };
    // Opened on first use so discovery-only loads never create the library file.
    let library: Library | null = null;
    const lib = (): Library => {
      library ??= new Library(
        new Store(process.env.OPENCLAW_RSS_DB ?? path.join(resolveStateDir(), "rss", "library.db")),
        guardedFetch,
        (reason) => changed(reason),
        (text) => api.logger.info(`[rss] ${text}`),
        async ({ system, input, maxTokens }) => {
          const chosen = lib().store.getSettings().gradingModel;
          const model = chosen === "decision" ? "" : chosen;
          const result = await api.runtime.llm.complete({
            ...(model ? { model } : {}),
            systemPrompt: system,
            messages: [{ role: "user", content: input }],
            purpose: "rss.grading",
            maxTokens,
            temperature: 0.2,
          });
          if (result.stopReason === "error" || !result.text?.trim()) throw new Error("The grading model returned no usable answer.");
          return result.text;
        },
        async ({ story, instructions, criteria }) => {
          const outcome = await api.runtime.decisions.evaluate(
            { state: story, questions: { grade: { type: "choice", instructions, criteria } } },
            { purpose: "rss.grading", rubricVersion: "1", timeoutMs: 20_000, signal: AbortSignal.timeout(25_000) },
          );
          if (outcome.status !== "ok") throw new Error(`The decision model is unavailable${"reason" in outcome && outcome.reason ? `: ${String(outcome.reason)}` : "."}`);
          const answer = outcome.result.answers.grade;
          if (answer?.type !== "choice") throw new Error("The decision model did not answer the question.");
          const probability = answer.probabilities?.[answer.choice];
          return { level: answer.choice, probability: typeof probability === "number" ? probability : null };
        },
      );
      return library;
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        await lib().refreshIfDue();
        void lib().drainCaptureQueue();
        lib().gradeIfDue();
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
        library?.stop();
        library?.store.close();
        library = null;
      },
    });

    const attempt = async <T>(work: () => T | Promise<T>): Promise<T | { error: string }> => {
      try { return await work(); }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    };
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
          settings: store.getSettings(), lastRefreshAt: last ? Number(last) : null, grading: lib().gradingStatus(),
        };
      },
      articles: (query) => lib().store.listArticles(query),
      article: ({ id, body }) => attempt(() => articleForWire(article(id), body)),
      export_opml: () => ({ xml: lib().exportOpml() }),
      add_feed: ({ url, folder }) => attempt(() => lib().addFeed(url, folder)),
      update_feed: ({ id, title, folder, move }) => {
        lib().store.updateFeed(id, { title, folder });
        if (move) lib().store.moveFeed(id, move);
        changed("feed-updated");
        return { ok: true };
      },
      remove_feed: ({ id }) => { lib().store.removeFeed(id); changed("feed-removed"); return { ok: true }; },
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
      capture: ({ id }) => attempt(async () => { await lib().capture(id); return articleForWire(article(id)); }),
      import_opml: ({ xml }) => attempt(() => lib().importOpml(xml)),
      set_settings: (patch) => {
        const before = lib().store.getSettings();
        const next = lib().store.setSettings(patch);
        // A new rubric makes the old verdicts stale.
        if (next.gradingRubric.trim() !== before.gradingRubric.trim()) lib().store.clearGrades();
        changed("settings");
        lib().gradeIfDue();
        return next;
      },
      // Starts the run and answers at once: a model call can take a minute, and the reader must stay usable meanwhile.
      grade: ({ regrade }) => attempt(() => {
        if (regrade) lib().store.clearGrades();
        const remaining = lib().store.ungradedCount();
        void lib().gradePending({ manual: true }).catch(() => {});
        return { graded: 0, remaining };
      }),
      add_rule: ({ phrase, feedId }) => attempt(() => { const id = lib().store.addRule(phrase, feedId ?? null); changed("rules"); return { id }; }),
      remove_rule: ({ id }) => { lib().store.removeRule(id); changed("rules"); return { ok: true }; },
      add_search: (search) => { const id = lib().store.addSearch(search); changed("searches"); return { id }; },
      remove_search: ({ id }) => { lib().store.removeSearch(id); changed("searches"); return { ok: true }; },
    };
  },
});
