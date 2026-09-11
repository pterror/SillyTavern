import { color } from '../util.js';

/**
 * Shared per-handle coordinator keeping a persistent search index fresh without blocking a request behind a
 * rebuild: at most one rebuild in flight per handle, and a stale index is served immediately while the rebuild
 * runs in the background. Safe because every query here runs fully synchronously (better-sqlite3/wasm), so a
 * caller that already grabbed the old live entry finishes its query before any swap can happen underneath it.
 *
 * `openStale` handles cold start (no entry yet, e.g. right after a restart): without it, the first request
 * after a large boot-time import blocks on a full incremental catch-up. `openStale` opens the last-persisted
 * state fast (no replay) to serve immediately, with `build()` catching up in the background. Omit it (or have
 * it resolve empty) to fall back to blocking - there's nothing to serve either way.
 * @template TDb
 */
export function createIndexCoordinator() {
    /** @type {Map<string, { db: TDb, signature: string | null }>} */
    const indexes = new Map();
    /** @type {Map<string, Promise<{ db: TDb, signature: string }>>} */
    const pendingBuilds = new Map();
    /** At most one cold-start sequence (openStale attempt, or blocking fallback build) per handle. Kept
     * separate from `pendingBuilds` so a concurrent cold-start caller can't slip through in the gap between
     * `openStale()` resolving and its background `build()` starting.
     * @type {Map<string, Promise<TDb>>} */
    const coldStarts = new Map();

    function startBuild(handle, signature, build, previousDb) {
        const promise = Promise.resolve()
            .then(() => build(previousDb))
            .then(db => ({ db, signature }))
            .finally(() => pendingBuilds.delete(handle));
        pendingBuilds.set(handle, promise);
        return promise;
    }

    /** Runs `build()` in the background, then swaps the live entry and closes the old handle - unless
     * `build()` updated `previousDb` in place (same reference), in which case there's nothing to close. */
    function scheduleBackgroundBuild(handle, signature, build, previousDb) {
        startBuild(handle, signature, build, previousDb)
            .then(newEntry => {
                const previous = indexes.get(handle);
                indexes.set(handle, newEntry);
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
         * Returns the live index entry for `handle`, kicking off a rebuild if missing or stale. Only blocks
         * when there's no existing entry AND `openStale` is absent or comes up empty.
         * @param {() => (TDb | null | undefined | Promise<TDb | null | undefined>)} [openStale] Must be fast
         * (no catch-up work) and must not persist any watermark itself - `build()` does that once it catches up.
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

            // No live entry yet; the get-then-set below has no `await` between them, so every concurrent
            // caller for this handle joins the same promise instead of racing its own openStale()/build().
            let coldStart = coldStarts.get(handle);
            if (!coldStart) {
                coldStart = (async () => {
                    if (openStale) {
                        const staleDb = await openStale();
                        if (staleDb) {
                            // signature: null never equals a real signature, so this is always treated as
                            // stale on the next call, correctly, until the background build catches it up.
                            indexes.set(handle, { db: staleDb, signature: null });
                            scheduleBackgroundBuild(handle, signature, build, staleDb);
                            return staleDb;
                        }
                    }
                    const built = await startBuild(handle, signature, build, undefined);
                    indexes.set(handle, built);
                    return built.db;
                })().finally(() => coldStarts.delete(handle));
                coldStarts.set(handle, coldStart);
            }
            return coldStart;
        },
        /**
         * Forces an immediate, blocking rebuild for `handle` regardless of signature - the explicit repair
         * path. Joins an already-in-flight build rather than starting a second one, preserving the
         * at-most-one-build-per-handle invariant `getIndex()` relies on.
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
