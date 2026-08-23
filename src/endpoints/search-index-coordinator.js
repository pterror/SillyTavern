import { color } from '../util.js';

/**
 * Shared per-handle "keep a persistent index fresh without ever blocking a request behind a rebuild" coordinator
 * for the character and group SQLite FTS5 search indexes (characters-search-index.js, groups-search-index.js).
 * Both modules previously each inlined the same "rebuild if the freshness signature changed" check directly in
 * their exported search function, `await`ed right there in the request path. That had two real problems, found
 * by reproducing a live 18+ second search request server-side and tracing it back to this exact code shape:
 *
 *   1. NO LOCK: two requests landing while the signature was stale would both see the same stale entry and both
 *      call buildSqliteIndex() concurrently - two full rebuilds racing to delete/recreate the same db file at
 *      once, each paying the full build cost (and fighting each other for disk I/O, which is why the observed
 *      18.54s outlier was ~3x the ~6s single-rebuild baseline this install's own doc comments measured).
 *   2. BLOCKS ON REBUILD: even without the race, *every* request that happened to observe a stale signature
 *      paid the entire rebuild cost inline before it got an answer - multiple seconds of dead air on what's
 *      supposed to be a search-as-you-type endpoint, even though a perfectly usable (just slightly outdated)
 *      index was sitting right there the whole time.
 *
 * This coordinator fixes both: at most one rebuild is ever in flight per handle (a second stale-triggering
 * request just reuses the in-flight promise instead of starting its own), and - except for a handle's very
 * first search since process start where `openStale` (below) isn't provided or comes up empty, where there's no
 * existing index to fall back to at all - a stale index is served immediately while the rebuild proceeds in the
 * background, so no request pays the rebuild cost except that unavoidable case. A background rebuild finishing
 * swaps the live entry and closes the old db handle; that's safe to do without disrupting an in-flight query
 * because every query in this codebase runs fully synchronously (better-sqlite3 and node-sqlite3-wasm are both
 * blocking) with no `await` between grabbing the live entry and calling the query on it - so a request that
 * already grabbed the old entry has necessarily already finished its synchronous query by the time any later
 * microtask (including this module's own rebuild-complete handler) gets a turn to run.
 *
 * COLD START (a handle's first `getIndex()` call this process, e.g. right after a server restart): the pre-`openStale`
 * version of this coordinator always blocked here, because there was nothing in `indexes` yet to serve instead of
 * waiting on `build()`. That's fine when `build()` is cheap, but for a caller whose `build()` can itself be an
 * expensive incremental catch-up (characters-search-index.js's tantivy tier, reopening a persisted index and
 * replaying every change since its last-caught-up rev) it reintroduced exactly the blocking-request problem this
 * module exists to prevent, in a specific and real shape: a boot-time bulk import (local-import-scan.js) runs
 * *before* any search request has happened, so the very first search after that import is a cold start with a
 * large backlog of changes to catch up on - confirmed as the root cause of an observed 60+ second search request
 * (no rebuild was racing, no signature-staleness case was hit in the warm path above; it was purely "nothing to
 * serve yet, so block on the full catch-up"). `openStale` (optional) gives a caller a fast, non-catching-up way to
 * open *something* usable to serve immediately in that case - e.g. `Index.open()` plus reading the last-persisted
 * watermark, no replay of pending changes - so a cold start degrades to "serve the last-persisted state, catch up
 * in the background" instead of "block on the catch-up." If `openStale` is omitted or resolves to nothing (a
 * genuinely fresh install with no persisted index at all), this falls back to the original blocking behavior -
 * there is nothing to serve either way.
 * @template TDb
 */
export function createIndexCoordinator() {
    /** @type {Map<string, { db: TDb, signature: string | null }>} */
    const indexes = new Map();
    /** @type {Map<string, Promise<{ db: TDb, signature: string }>>} */
    const pendingBuilds = new Map();
    /** @type {Map<string, Promise<TDb>>} At most one cold-start sequence (openStale attempt, or the blocking
     * fallback build) per handle - see getIndex()'s cold-start branch. Kept separate from `pendingBuilds` because
     * a successful `openStale()` resolves this map's promise fast (right after opening, before `build()` even
     * starts), while `pendingBuilds` needs to keep tracking the *background* `build()` call that follows -
     * merging the two would let `pendingBuilds` look briefly empty in between and let a second concurrent
     * cold-start caller slip through and start a duplicate `openStale()`+background-build pair. */
    const coldStarts = new Map();

    /**
     * @param {string} handle
     * @param {string} signature
     * @param {(previous: TDb | undefined) => TDb | Promise<TDb>} build
     * @param {TDb} [previousDb]
     * @returns {Promise<{ db: TDb, signature: string }>}
     */
    function startBuild(handle, signature, build, previousDb) {
        const promise = Promise.resolve()
            .then(() => build(previousDb))
            .then(db => ({ db, signature }))
            .finally(() => pendingBuilds.delete(handle));
        pendingBuilds.set(handle, promise);
        return promise;
    }

    /**
     * Kicks off `build()` in the background against `previousDb`, and once it resolves, swaps the live entry to
     * the result and closes the old handle - unless `build()` updated `previousDb` in place (returned the exact
     * same reference), in which case there's nothing to close. Shared by the warm-stale path and the cold-start
     * `openStale` path below - both need the exact same "don't block on this, but swap it in and clean up the old
     * one once it lands" behavior.
     * @param {string} handle
     * @param {string} signature
     * @param {(previous: TDb | undefined) => TDb | Promise<TDb>} build
     * @param {TDb} previousDb
     */
    function scheduleBackgroundBuild(handle, signature, build, previousDb) {
        startBuild(handle, signature, build, previousDb)
            .then(newEntry => {
                const previous = indexes.get(handle);
                indexes.set(handle, newEntry);
                // An in-place-updated handle (previous === newEntry.db) must not be closed out from under
                // itself - only a genuinely different handle (a from-scratch rebuild) gets its old one closed.
                if (previous?.db !== newEntry.db) {
                    previous?.db?.close?.();
                }
            })
            .catch(err => {
                console.error(color.red(`[search] background rebuild of the search index failed for ${handle}:`));
                console.error(color.red(`[search]   ${err.message}`));
            });
    }

    return {
        /**
         * Returns the live index entry for `handle`, kicking off a rebuild if it's missing or stale. Only
         * blocks the caller when there's no existing entry to serve in the meantime AND `openStale` is either
         * not given or comes up empty (see this module's header on the cold-start case `openStale` exists for)
         * - a stale-but-present entry (whether already live, or just opened via `openStale`) is returned
         * immediately, with a background rebuild started (or, if one's already in flight for this handle, left
         * to finish on its own) to catch the *next* request up to date.
         * @param {string} handle User handle
         * @param {string} signature Current freshness signature (see each caller's own getFreshnessSignature())
         * @param {(previous: TDb | undefined) => TDb | Promise<TDb>} build Returns a freshly opened, fully
         * up-to-date db handle - called with the currently-live handle (or `undefined` on a handle's first-ever
         * build) so a caller can choose to update it in place (e.g. characters-search-index.js's incremental
         * tantivy maintenance, design doc §3.3 item 3) instead of always rebuilding from scratch. A caller that
         * doesn't need this (every other current use) just ignores the argument, exactly like before this param
         * existed.
         * @param {() => (TDb | null | undefined | Promise<TDb | null | undefined>)} [openStale] Only called on a
         * cold start (no entry, no build already in flight) - see this module's header. Must be fast (no
         * catch-up work) and must NOT persist any watermark itself (it's serving an already-stale state on
         * purpose; `build()`, called right after via the normal background path, is what's responsible for
         * catching up and persisting the new watermark). Returning `null`/`undefined` (nothing usable persisted
         * yet) falls back to the original blocking behavior.
         * @returns {Promise<TDb>}
         */
        async getIndex(handle, signature, build, openStale) {
            const entry = indexes.get(handle);

            if (entry) {
                if (entry.signature !== signature && !pendingBuilds.has(handle)) {
                    scheduleBackgroundBuild(handle, signature, build, entry.db);
                }
                // Either already fresh, or stale with a rebuild now in flight (started just above, or already
                // running from a previous call) - either way, serve what's currently live rather than waiting.
                return entry.db;
            }

            // No live entry yet. `coldStarts` reserves this handle's "figure out what to serve" sequence
            // synchronously (the get-then-set below has no `await` between them, so two concurrent calls can
            // never both see it missing) - every concurrent caller for this handle joins the same promise
            // instead of each independently calling `openStale()` and each scheduling their own background
            // build (exactly the N-duplicate-rebuild race this whole module exists to close).
            let coldStart = coldStarts.get(handle);
            if (!coldStart) {
                coldStart = (async () => {
                    if (openStale) {
                        const staleDb = await openStale();
                        if (staleDb) {
                            // `signature: null` can never equal a real signature (always a caller-computed
                            // string), so this is unconditionally treated as stale on the next call - correct,
                            // since `build()` hasn't caught it up to `signature` yet. Serve it now, catch up in
                            // the background via the same path a warm-stale hit uses.
                            indexes.set(handle, { db: staleDb, signature: null });
                            scheduleBackgroundBuild(handle, signature, build, staleDb);
                            return staleDb;
                        }
                    }
                    // Nothing to serve yet at all (no `openStale`, or it came up empty - a genuinely fresh
                    // install with no persisted index) - this genuinely has to block.
                    const built = await startBuild(handle, signature, build, undefined);
                    indexes.set(handle, built);
                    return built.db;
                })().finally(() => coldStarts.delete(handle));
                coldStarts.set(handle, coldStart);
            }
            return coldStart;
        },
        /**
         * Forces an immediate, blocking rebuild for `handle` regardless of the current signature - the explicit
         * "repair" path (design doc §3.2: "the existing full-rebuild path stays, demoted to a repair tool behind
         * an explicit endpoint rather than something a directory mtime change can trigger implicitly"). Bypasses
         * the "serve stale, rebuild in background" behavior `getIndex()` normally uses, since a caller hitting a
         * repair endpoint wants to know the rebuild actually happened, not get an immediate answer off a
         * possibly-corrupt index.
         * @param {string} handle
         * @param {string} signature Freshness signature to record for the freshly rebuilt index.
         * @param {() => TDb | Promise<TDb>} rebuild Always builds from scratch - callers pass their
         * full-rebuild function here, not their normal (possibly-incremental) `build`.
         * @returns {Promise<TDb>} If a build (incremental or full) was already in flight for this handle when
         * this was called, this joins that one rather than starting a second concurrent rebuild against the same
         * on-disk directory - deliberately, to preserve the "at most one build in flight per handle" invariant
         * `getIndex()` relies on, rather than reintroducing the exact two-rebuilds-racing-on-disk problem this
         * module exists to prevent (see this module's header). A caller that must be certain a *fresh* rebuild
         * ran (not just "whatever was already in flight") should await this, check the result, and call again if
         * genuinely unsatisfied - no current caller needs that.
         */
        async forceRebuild(handle, signature, rebuild) {
            const newEntry = await (pendingBuilds.get(handle) ?? startBuild(handle, signature, () => rebuild(), undefined));
            const previous = indexes.get(handle);
            indexes.set(handle, newEntry);
            if (previous?.db !== newEntry.db) {
                previous?.db?.close?.();
            }
            return newEntry.db;
        },
    };
}
