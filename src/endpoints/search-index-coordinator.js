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
 * first search since process start, where there's no existing index to fall back to at all - a stale index is
 * served immediately while the rebuild proceeds in the background, so no request pays the rebuild cost except
 * that unavoidable first one. A background rebuild finishing swaps the live entry and closes the old db handle;
 * that's safe to do without disrupting an in-flight query because every query in this codebase runs fully
 * synchronously (better-sqlite3 and node-sqlite3-wasm are both blocking) with no `await` between grabbing the
 * live entry and calling the query on it - so a request that already grabbed the old entry has necessarily
 * already finished its synchronous query by the time any later microtask (including this module's own
 * rebuild-complete handler) gets a turn to run.
 * @template TDb
 */
export function createIndexCoordinator() {
    /** @type {Map<string, { db: TDb, signature: string }>} */
    const indexes = new Map();
    /** @type {Map<string, Promise<{ db: TDb, signature: string }>>} */
    const pendingBuilds = new Map();

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

    return {
        /**
         * Returns the live index entry for `handle`, kicking off a rebuild if it's missing or stale. Only
         * blocks the caller when there's no existing entry to serve in the meantime (a handle's first search
         * since process start) - a stale-but-present entry is returned immediately, with a background rebuild
         * started (or, if one's already in flight for this handle, left to finish on its own) to catch the
         * *next* request up to date.
         * @param {string} handle User handle
         * @param {string} signature Current freshness signature (see each caller's own getFreshnessSignature())
         * @param {(previous: TDb | undefined) => TDb | Promise<TDb>} build Returns a freshly opened, fully
         * up-to-date db handle - called with the currently-live handle (or `undefined` on a handle's first-ever
         * build) so a caller can choose to update it in place (e.g. characters-search-index.js's incremental
         * tantivy maintenance, design doc §3.3 item 3) instead of always rebuilding from scratch. A caller that
         * doesn't need this (every other current use) just ignores the argument, exactly like before this param
         * existed.
         * @returns {Promise<TDb>}
         */
        async getIndex(handle, signature, build) {
            let entry = indexes.get(handle);

            if (!entry) {
                // Nothing to serve yet at all - this genuinely has to block, and concurrent first-searches for
                // the same handle share the one in-flight build below rather than each starting their own.
                entry = await (pendingBuilds.get(handle) ?? startBuild(handle, signature, build, undefined));
                indexes.set(handle, entry);
                return entry.db;
            }

            if (entry.signature !== signature && !pendingBuilds.has(handle)) {
                startBuild(handle, signature, build, entry.db)
                    .then(newEntry => {
                        const previous = indexes.get(handle);
                        indexes.set(handle, newEntry);
                        // An in-place-updated handle (previous === newEntry.db) must not be closed out from under
                        // itself - only a genuinely different handle (a from-scratch rebuild) gets its old one
                        // closed.
                        if (previous?.db !== newEntry.db) {
                            previous?.db?.close?.();
                        }
                    })
                    .catch(err => {
                        console.error(color.red(`[search] background rebuild of the search index failed for ${handle}:`));
                        console.error(color.red(`[search]   ${err.message}`));
                    });
            }

            // Either already fresh, or stale with a rebuild now in flight (started just above, or already
            // running from a previous call) - either way, serve what's currently live rather than waiting.
            return entry.db;
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
