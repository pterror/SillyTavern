import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { getConfigValue, color, mapWithConcurrency } from './util.js';
import { DEFAULT_USER, UPLOADS_DIRECTORY } from './constants.js';
import { getUserDirectories } from './users.js';
import { copyCharacterFile } from './local-import-copy.js';
import { reclaimReflinkPrefix } from './character-card-parser.js';
import { importCharacterFileHeadless, buildPngImportData, buildJsonImportData, mintCharacterId, fireMetadataUpsertHook } from './endpoints/characters.js';
import { beginBatchImport, endBatchImport, findCharacterIdByContentHash, findCharacterIdByContentIdentityHash, getLocalImportSkip, setLocalImportSkip, clearLocalImportSkip, getAllLocalImportMtimes, setLocalImportMtime, clearLocalImportMtime, seedCardTagsForSingleCharacter } from './character-metadata-db.js';
import { attachOverflowWatch, isWindowsOverflowSignal } from './watch-overflow.js';
import { detectFormat } from './local-import-classify.js';
import { LocalImportWorkerPool, resolveWorkerPoolSize } from './local-import-worker-pool.js';

/**
 * Config/admin-set-only "import characters from a local directory on disk" feature, as an alternative to
 * every existing import path (`POST /api/characters/import`) always going through a browser file upload. This
 * module never accepts a directory path from a request - the list it scans comes only from
 * `localImport.directories` in config.yaml - so it never becomes an arbitrary-path-read endpoint.
 *
 * THIS FOLLOWS THE EXACT SAME TWO-MECHANISM SHAPE character-metadata-db.js ALREADY USES for its own
 * characters-directory freshness problem (see that module's header), because it's the same reliability
 * problem: fs.watch/inotify can silently drop events past its queue depth under burst load, with no `error`
 * event and no way to detect it from JS, so it can only ever be a latency optimization, never the mechanism
 * actually relied on for correctness -
 *   1. A periodic scan (scanDirectory() below, driven by the `scanIntervalMs` interval per configured
 *      directory) - the mandatory backstop. Always runs, regardless of whether fs.watch is enabled or even
 *      available on this platform/filesystem.
 *   2. An optional non-recursive fs.watch() per configured directory (startWatcherFor() below, gated by
 *      `localImport.watchEnabled`) - purely a "notice new files sooner than the next scan interval" latency
 *      optimization layered on top. Its debounced handler runs the exact same per-file logic the periodic scan
 *      uses, so there is only ever one discovery/import code path, just two different triggers for it.
 *
 * DISCOVERED-FILE IMPORT reuses the exact same hash-dedup machinery, and (for charx/byaf/yaml only - see below)
 * the exact same batched staging `/import` and its `/metadata/batch-import/begin|end` counterparts already use
 * for a browser bulk drag-drop import, rather than a parallel implementation of it:
 *   - png/json (the two formats a real corpus is overwhelmingly made of - 2026-08 worker-owned-write extension):
 *     no staging at all. local-import-worker.js's worker pool reads the discovered file's bytes exactly once and
 *     owns the ENTIRE per-file pipeline itself - hash, classify, and (once processFile()'s per-hash-locked sqlite
 *     dedup check confirms the file is genuinely new) the extract/splice/encode/write of the final character
 *     file too, using characters.js's buildPngImportData()/buildJsonImportData() (the same pure per-spec
 *     business logic importFromPng()/importFromJson() use for `/import`) to build the data to embed. Only the
 *     post-write fireMetadataUpsertHook() sqlite call happens back on the main thread - see processFile()'s own
 *     comments for exactly where.
 *   - charx/byaf/yaml (unchanged from before this extension - see local-import-worker.js's own header on why
 *     these three are out of scope for it): copyCharacterFile() (local-import-copy.js) stages the discovered
 *     file's bytes into this install's normal uploads directory (the same directory multer stages a browser
 *     upload into) via reflink/hardlink where the filesystem allows it, falling back to a full copy only if
 *     configured to, then importCharacterFileHeadless() (characters.js) drives that staged copy through the
 *     identical format-dispatch table, hash-based exact-duplicate dedup, and writeCharacterData()/metadata-upsert
 *     path `POST /import` uses.
 *   - beginBatchImport()/endBatchImport() wrap each scan pass regardless of format mix, so a directory holding
 *     many files pays one SQLite transaction/watcher-suspension window per pass instead of one per file,
 *     identical to what a bulk drag-drop import already gets
 *
 * SINGLE-USER SCOPE (owner decision - this feature targets this fork's personal single-user deployment shape):
 * every discovered file is imported into DEFAULT_USER's library, regardless of `enableUserAccounts`. Extending
 * this to route different configured directories to different user handles on a multi-user install is
 * explicitly out of scope here, not an oversight.
 *
 * CONTENT-IDENTITY DUPLICATE FALLBACK (`performance.allowExpensiveDuplicateFallback`): the content_hash fast
 * path above only ever catches a byte-identical re-drop. It cannot recognize a semantic duplicate between an
 * already-poisoned library row (see character-metadata-db.js's content_identity_hash/import_poisoned columns)
 * and a newly-discovered file that's the same character but byte-different - because the poisoned row went
 * through the old, more-mutating import logic and never got a chance to record a hash comparable to a fresh
 * import's. computeCandidateContentIdentityHash() below closes that gap: when the flag is on and the fast path
 * found nothing, it non-destructively parses the candidate (no import, nothing written or consumed - unlike
 * importCharacterFileHeadless(), which commits an import as a side effect) into the same normalized shape
 * computeContentIdentityHash() always hashes from, then does an O(1) indexed lookup
 * (findCharacterIdByContentIdentityHash()) against every row whose hash is trustworthy - which, thanks to
 * character-metadata-db.js's backfillContentIdentityHashes(), now includes the poisoned rows too (their hash was
 * recovered from their PNG's pristine 'chara' chunk, not their mutated ccv3 one).
 */

/** How often (ms) the fs.watch debounce handler coalesces bursts of raw fs events for the same filename into one
 * scan of that single file - same purpose and same default as character-metadata-db.js's WATCH_DEBOUNCE_MS,
 * kept as a separate constant (not imported) since the two watchers watch different directories for a
 * different purpose and have no reason to be forced to share a literal. */
const WATCH_DEBOUNCE_MS = 300;

/**
 * @typedef {object} DirectoryScanState
 * @property {string} sourceDir Absolute path to the configured directory being watched/scanned
 * @property {Map<string, number>} lastSeenMtimeMs Per-filename mtimeMs as of the last pass that processed it -
 * an efficiency-only skip cache (mirrors reconcile()'s stored file_mtime comparison in character-metadata-db.js):
 * skipping a file whose mtime hasn't changed since last processed avoids re-hashing/re-checking it on every
 * pass, but is never relied on for correctness - content-hash dedup makes reprocessing a file always safe, just
 * wasteful. This Map itself is in-memory-only and starts empty every process start, but initializeLocalImportScan()
 * warms it from character-metadata-db.js's persisted `local_import_mtimes` table (getAllLocalImportMtimes())
 * before the first pass runs, and processFile() writes through to that table (setLocalImportMtime()) whenever it
 * updates this Map - so the skip DOES survive a restart in practice, it just isn't this Map's own job to persist
 * it. A directory scanned via scanDirectory() directly with a hand-built, never-warmed state (e.g. a test, or a
 * config/directories change this process hasn't restarted for) simply starts that one state cold, same as
 * before - never incorrect, only ever a first-pass cost.
 * @property {fs.FSWatcher | null} watcher
 * @property {Map<string, NodeJS.Timeout>} watchTimers Per-filename debounce timers, mirrors
 * character-metadata-db.js's watchTimers.
 * @property {{ close: () => void } | null} overflowWatch Linux-only dedicated overflow watch (see
 * watch-overflow.js's attachOverflowWatch()) - `null` on every other platform, or if attaching one failed for
 * any reason (never fatal - see that module's own doc comment). Entirely separate from `watcher` above; closed
 * independently in stopWatcherFor().
 * @property {Map<string, Promise<void>>} [hashLocks] Per-content-hash serialization for the worker-pool era
 * (see withPerHashLock()'s own doc comment) - optional/lazily-created (withPerHashLock() populates it on
 * first use if absent) so a hand-built state literal (e.g. a test's buildState() helper, predating this
 * property) never needs updating just to keep constructing a valid DirectoryScanState.
 */

/** @type {DirectoryScanState[]} */
let scanStates = [];
/** @type {NodeJS.Timeout | null} */
let scanTimeout = null;
/** @type {import('./users.js').UserDirectoryList | null} Captured by initializeLocalImportScan() so
 * triggerImmediateRescan() (called from a watcher-overflow signal, long after that function returned) can
 * still reach the exact same arguments runScanCycle() needs - see that function's own doc comment. */
let capturedUserDirectories = null;
/** @type {number | null} Same reasoning as capturedUserDirectories - captured once at init, read by
 * triggerImmediateRescan(). */
let capturedScanIntervalMs = null;
/** Set true by disposeLocalImportScan() to tell a scan cycle already in flight (see runScanCycle()) to stop
 * rescheduling itself once its current pass finishes, rather than only clearing scanTimeout - a pass can be
 * mid-flight (not yet at its own reschedule point) when dispose is called, and without this flag it would still
 * queue one more scanTimeout right after a disposed instance's teardown. */
let disposed = false;
/** @type {Promise<void> | null} The in-flight (or most recently completed) full pass over every configured
 * directory - see runScanCycle(). Exported via waitForCurrentScanPass() below purely for tests/observability
 * (e.g. "has the initial post-restart pass finished yet") - production code (server-main.js) never awaits this,
 * that is the whole point of backgrounding it (see initializeLocalImportScan()'s own doc comment). */
let currentPassPromise = null;
/** @type {LocalImportWorkerPool | null} Lazily created by ensureWorkerPool() on first use (either
 * initializeLocalImportScan() or a direct scanDirectory()/processFile() call, e.g. from a test that never
 * calls initializeLocalImportScan() at all) and reused for the lifetime of this module's process - see
 * ensureWorkerPool()'s own doc comment on why a pool is created once and shared, not once per pass/file.
 * Disposed and cleared only by disposeLocalImportScan(). */
let workerPool = null;

/**
 * Returns the shared worker pool used by processFile() (both the periodic-scan and fs.watch call paths -
 * see this module's header) to run each file's CPU-bound pre-import work (hashing/parsing - see
 * local-import-worker.js) off the main thread, creating it on first use if one doesn't already exist. A
 * single pool is reused across every call in this module's process, not recreated per pass or per file -
 * spinning up worker_threads has real (if small) startup cost, and the whole feature exists for throughput
 * on a large corpus, not to pay that cost per file. Sized via resolveWorkerPoolSize() (see that function's
 * own doc comment on the config knob and default).
 * @returns {LocalImportWorkerPool}
 */
function ensureWorkerPool() {
    if (!workerPool) {
        workerPool = new LocalImportWorkerPool(resolveWorkerPoolSize());
    }
    return workerPool;
}

/**
 * @returns {string} This install's normal uploads staging directory - the exact same one multer stages a browser
 * `/import` upload into (see server-main.js's "File uploads" section / users.js's cleanUploads()) - reused here
 * rather than inventing a second staging location, so a staged local-import file gets the same lifecycle
 * (importCharacterFileHeadless()'s underlying importFromX() functions delete/unlink it as part of processing,
 * exactly as they already do to a multer upload).
 */
function getUploadsDir() {
    return path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
}

/**
 * Stages `sourcePath`'s bytes into the uploads directory under a fresh, collision-proof name (copyCharacterFile()
 * fails loud rather than overwrite - see that function's own contract - so the target must never already exist;
 * a randomUUID-derived name guarantees that regardless of how many files with the same original basename are
 * being staged concurrently across configured directories).
 * @param {string} sourcePath
 * @returns {Promise<string>} The staged file's absolute path
 */
async function stageFile(sourcePath) {
    const uploadsDir = getUploadsDir();
    if (!fs.existsSync(uploadsDir)) {
        await fsPromises.mkdir(uploadsDir, { recursive: true });
    }
    const stagedName = `${crypto.randomUUID()}${path.extname(sourcePath)}`;
    const stagedPath = path.join(uploadsDir, stagedName);
    await copyCharacterFile(sourcePath, stagedPath);
    return stagedPath;
}

/**
 * When a duplicate is detected (source file matches an already-imported character by content or identity
 * hash), reclaims disk space by making the canonical character file share its image-data extents with the
 * source via reflink - the source archive file is only ever reflinked FROM (never opened for writing), so
 * the archive stays genuinely untouched. A no-op on filesystems without COW/reflink support, or when the
 * canonical file's image-data prefix doesn't byte-match the source's (see reclaimReflinkPrefix()'s own
 * doc comment for the full verification it applies before touching anything).
 *
 * Unlike the removed maybeHardlinkDuplicateSource (which replaced SOURCE files with hardlinks to the
 * canonical copy, destroying the archive's independence), this only ever modifies the app-managed
 * canonical copy inside this install's own data directory, so it needs no config opt-in.
 * @param {string} sourcePath Absolute path to the duplicate source file in the scanned directory.
 * @param {string} characterId The already-imported character's avatar filename (e.g. '01a0....png').
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>} Never throws.
 */
async function maybeReflinkDuplicateTarget(sourcePath, characterId, directories) {
    const targetPath = path.join(directories.characters, characterId);

    let targetStat;
    try {
        targetStat = await fsPromises.stat(targetPath);
    } catch {
        // Canonical file doesn't exist (stale DB record?) - nothing to reclaim against.
        return;
    }
    if (!targetStat.isFile()) return;

    try {
        const result = await reclaimReflinkPrefix(targetPath, sourcePath);
        if (result.reflinked) {
            console.log(color.cyan(`[local-import] Deduplicated on disk: ${targetPath} reflinked to share extents with source ${sourcePath} (source left untouched).`));
        }
    } catch (err) {
        console.debug(`[local-import] Reflink dedup failed for ${targetPath} <- ${sourcePath}:`, /** @type {any} */ (err)?.message ?? err);
    }
}

/**
 * Records that `filename` has been processed as of `mtimeMs` in both the in-memory skip cache and its persisted
 * counterpart (see DirectoryScanState.lastSeenMtimeMs's own doc comment on why there are two) - every call site
 * in processFile() that used to only update the in-memory Map now goes through here instead, so the two never
 * drift apart. The persisted write is fire-and-forget/best-effort (see setLocalImportMtime()'s own doc comment
 * on why a failure here is never a correctness problem, only a lost efficiency gain on the next restart).
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 * @param {string} filename
 * @param {number} mtimeMs
 */
async function markProcessed(state, directories, sourcePath, filename, mtimeMs) {
    state.lastSeenMtimeMs.set(filename, mtimeMs);
    // Awaited, not fire-and-forget: the underlying write is a single synchronous better-sqlite3 call under an
    // async wrapper (see setLocalImportMtime()), so awaiting it costs nothing real, and NOT awaiting it left a
    // dangling promise per file with no guaranteed completion order relative to whatever runs next (a scan pass
    // moving on to the next file, a test's own assertions, disposeMetadataStores() closing the db handle out
    // from under a still-pending write) - caught a real cross-test race in practice, not a theoretical one. The
    // try/catch (not a rejection the caller sees) keeps this a pure efficiency write: a failure here only costs
    // a wasted re-read on the next restart, never a wrong result now.
    try {
        await setLocalImportMtime(directories, sourcePath, mtimeMs);
    } catch (err) {
        console.debug(`[local-import] Failed to persist processed-mtime record for ${sourcePath} (will just be re-processed on the next restart, not incorrectly):`, err.message);
    }
}

/**
 * Records that `filename` has been processed as of `mtimeMs` in the in-memory skip cache ONLY - deliberately
 * NOT persisted (unlike markProcessed()) - for the two "recognized as a duplicate of some OTHER already-imported
 * character" outcomes (an exact content_hash match, or the expensive content-identity fallback match). Found via
 * a real reproduction, not theorized: a duplicate match's validity depends on that OTHER character's row still
 * existing, which can stop being true later (e.g. character-metadata-db.js's reconcile() deletes a row once its
 * own file goes missing on disk - a real, ordinary occurrence, not an edge case). Persisting THIS file's mtime
 * across a restart in that case would make a fresh, warmed DirectoryScanState (see warmMtimeCache()) skip
 * re-checking it forever via the plain mtime-unchanged fast path, even after the character it was a duplicate
 * OF no longer exists to be a duplicate of - silently losing the source file's only path back into the library.
 * The in-memory-only record still gets the SAME-run efficiency win markProcessed() does (two back-to-back passes
 * within one boot won't re-hash this file either), it just doesn't survive a restart - the exact same posture
 * every mtime skip had before local_import_mtimes existed at all, so this is a narrowing of the new feature's
 * scope to the cases it's actually safe for, not a regression relative to before that feature landed.
 * @param {DirectoryScanState} state
 * @param {string} filename
 * @param {number} mtimeMs
 */
function markProcessedInMemoryOnly(state, filename, mtimeMs) {
    state.lastSeenMtimeMs.set(filename, mtimeMs);
}

/**
 * Discovers-and-imports one file if it looks new/changed and isn't already in the library (by content hash).
 * Shared by both the periodic scan and the (optional) fs.watch handler - see this module's header on why there
 * is only ever one such code path.
 * @param {DirectoryScanState} state
 * @param {string} filename
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
/**
 * Tidies up stale local_import_skips/local_import_mtimes rows (and the in-memory lastSeenMtimeMs entry) once
 * `filename` is known to be genuinely gone from `state.sourceDir` - shared by processFile()'s own ENOENT branch
 * (a file removed WITHIN this pass, between readdir() listing it and stat()'ing it - a narrow race) and
 * scanDirectory()'s post-readdir sweep (a file removed BETWEEN passes entirely - the ordinary case, and the one
 * ENOENT alone can never catch: readdir() simply never lists a file that's already gone by the time it runs, so
 * processFile() is never even called for it, and a durable skip/mtime row for it would otherwise survive
 * forever). Neither table records a file's format, so this always attempts the local_import_skips clear too
 * (a no-op DELETE if there was never a row there - see clearLocalImportSkip()'s own idempotent DELETE) rather
 * than requiring the caller to know/pass the format.
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filename
 * @returns {Promise<void>} Never throws - each clear is independently best-effort (see clearLocalImportMtime()'s
 * and clearLocalImportSkip()'s own doc comments on why a failure here is never a correctness problem).
 */
async function cleanupRemovedFile(state, directories, filename) {
    state.lastSeenMtimeMs.delete(filename);
    const sourcePath = path.join(state.sourceDir, filename);
    try {
        await clearLocalImportMtime(directories, sourcePath);
    } catch (clearErr) {
        console.debug(`[local-import] Failed to clear stale local_import_mtimes record for ${sourcePath}:`, clearErr.message);
    }
    try {
        await clearLocalImportSkip(directories, sourcePath);
    } catch (clearErr) {
        console.debug(`[local-import] Failed to clear stale local_import_skips record for ${sourcePath}:`, clearErr.message);
    }
}

/**
 * Serializes concurrent processFile() calls that land on the SAME content hash within one directory's scan
 * pass, so `fn` (the dedup-check-then-maybe-import critical section) never runs for two files sharing a hash
 * at the same time. Necessary specifically because scanDirectory() now dispatches files with real
 * concurrency (mapWithConcurrency(), bounded by the worker pool size - see that call site) instead of one at
 * a time: two DIFFERENT source files with byte-identical content, discovered in the same pass, would
 * otherwise both reach findCharacterIdByContentHash() before either had actually committed an import,
 * both find nothing, and both import - a real TOCTOU race reproduced via this module's own test suite once
 * concurrent dispatch landed (there is no UNIQUE constraint on `characters.content_hash`, and
 * importCharacterFileHeadless()'s own re-check right before writing has the identical shape of race, so it
 * cannot single-handedly prevent this either). Files with DIFFERENT hashes are never blocked by each other -
 * only same-hash collisions are serialized - so this doesn't undo the throughput this pool exists for.
 * @param {DirectoryScanState} state
 * @param {string} hash
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
function withPerHashLock(state, hash, fn) {
    if (!state.hashLocks) state.hashLocks = new Map();
    // The map only ever stores a chain that's been through .catch(() => {}) below, so it can never itself be a
    // rejected promise - `prior` is always safe to .then() off of without also handling a rejection case here.
    const prior = state.hashLocks.get(hash) ?? Promise.resolve();
    const run = prior.then(fn);
    // The stored chain must never itself reject (a rejection here would permanently poison every future
    // waiter for this hash within the pass, not just this one caller) - `run` (returned to THIS call's own
    // caller) still carries the real outcome/rejection; only the map's internally-chained copy is swallowed.
    state.hashLocks.set(hash, run.catch(() => { }));
    return run;
}

function readTagImportSetting(directories) {
    try {
        const settingsPath = path.join(directories.root, 'settings.json');
        if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const val = settings.power_user?.tag_import_setting;
            if (val === 2) return 2;
            if (val === 4) return 4;
        }
    } catch { /* use default */ }
    return 3;
}

async function processFile(state, filename, directories, tagImportSetting = 3) {
    const format = detectFormat(filename);
    if (!format) return;

    const sourcePath = path.join(state.sourceDir, filename);
    let stat;
    try {
        stat = await fsPromises.stat(sourcePath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // Removed between listing and stat'ing (within THIS pass), or a watcher event for a since-deleted
            // file - see cleanupRemovedFile()'s own doc comment on why the far more common "removed since the
            // last pass entirely" case is handled separately, in scanDirectory()'s post-readdir sweep, not here.
            await cleanupRemovedFile(state, directories, filename);
            return;
        }
        throw err;
    }

    if (!stat.isFile()) return;

    if (state.lastSeenMtimeMs.get(filename) === stat.mtimeMs) {
        return; // Unchanged since the last pass that processed it - see lastSeenMtimeMs's own doc comment.
    }

    // Durable "never importable" check (see character-metadata-db.js's local_import_skips SCHEMA_SQL comment):
    // only meaningful for .json (classifyJsonCandidate() below is the only classifier that populates this table
    // so far). Gated on the file's CURRENT mtime matching the mtime the skip was recorded against - a file that
    // has since changed (e.g. the owner turned a stray lorebook export into a real character card) naturally
    // falls through to a fresh classification/import attempt below instead of staying permanently skipped.
    if (format === 'json') {
        const existingSkip = await getLocalImportSkip(directories, sourcePath);
        if (existingSkip && existingSkip.mtimeMs === stat.mtimeMs) {
            // Already positively classified and logged once when the skip was first recorded - nothing new to
            // report. Still mark this pass so next pass's cheap early-return above short-circuits this
            // same lookup too, exactly like a successful import's own bookkeeping.
            await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
            return;
        }
    }

    // Read fresh via getConfigValue() (not the module-level cached export in character-metadata-db.js) so this
    // reflects a config/env change on the very next scan pass - see that export's own updated doc comment for
    // why. Read here (before dispatching to the worker) so the worker never computes an identity hash the
    // config would just have discarded - see local-import-worker.js's own header on why this flag travels
    // with the task rather than being re-read inside the worker.
    const allowIdentityFallback = getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean');

    try {
        // The CPU-bound part of this file's work - read, sha256 hash, (for .json) the not-a-card/wrong-shape
        // classification, (unless already short-circuited by that classification, and only if
        // allowIdentityFallback) the content-identity parse+hash, AND (2026-08 worker-owned-write extension,
        // png/json only) the eventual extract/splice/encode/write of the imported character file itself - runs
        // entirely inside a worker thread, reading `sourcePath`'s bytes exactly once (see
        // local-import-worker.js/local-import-worker-pool.js's own headers on why: this was measured as a real,
        // substantial main-thread CPU bottleneck on the owner's real corpus - 2026-08 local-import worker-pool
        // investigation - and every step here is pure/DB-free, so it's safe to run off-thread). Only the
        // source file PATH crosses into the worker on the way in, and only small strings (contentHash,
        // jsonClassification, identityHash, rawText, and later the final `data`/destPath for the write) cross
        // either direction after that - the multi-megabyte file buffer/chunk list itself never does.
        //
        // Every sqlite read/write below (getLocalImportSkip already ran above; findCharacterIdByContentHash,
        // findCharacterIdByContentIdentityHash, setLocalImportSkip, markProcessed, and - once a write actually
        // lands - fireMetadataUpsertHook()) stays on THIS (main) thread, unchanged from before - see
        // local-import-worker.js's header for why worker-thread sqlite access would be unsafe here (no WAL
        // journal mode/busy_timeout configured, and scanDirectory() wraps a whole pass in one write transaction
        // via beginBatchImport()/endBatchImport()).
        const pipelineResult = await ensureWorkerPool().runPipeline(sourcePath, format, directories, allowIdentityFallback);

        // Permanent-skip classification (see local-import-classify.js's classifyJsonCandidate() doc comment):
        // computed in the worker above; acted on here exactly as before - never confused with, or masking, a
        // real failure in the staging/import machinery below. Only ever short-circuits format 'json' candidates
        // positively determined to be either not valid JSON at all, or valid JSON that isn't a recognized
        // character-card shape; everything else falls through to the exact same import attempt as before, which
        // keeps its own existing retry-on-failure behavior for genuinely transient problems untouched.
        if (format === 'json' && pipelineResult.jsonClassification) {
            const classification = pipelineResult.jsonClassification;
            const reasonText = classification === 'not-json'
                ? 'not valid JSON (the content does not look like a character card - possibly a misnamed/mislabeled file, e.g. an image saved with a .json extension)'
                : 'valid JSON but not a recognized character card shape (no spec/name/char_name field - likely a lorebook/world-info export or other non-character JSON)';
            console.warn(color.yellow(`[local-import] Permanently skipping ${sourcePath}: ${reasonText}. Will not retry unless the file changes.`));
            await setLocalImportSkip(directories, sourcePath, stat.mtimeMs, classification);
            await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
            return;
        }

        if (format === 'json') {
            // Reaching here for a .json candidate means: this file is NOT skip-worthy at its current bytes -
            // either it never was, or (the case this specifically guards) it WAS previously skip-classified at
            // an older mtime and has since been edited into something the worker's classification no longer
            // rejects (e.g. a stray lorebook export the owner turned into a real character card). The mtime-gated
            // early-return above already established any existingSkip row here is for a DIFFERENT (stale) mtime
            // if one exists at all - clear it unconditionally (a no-op DELETE if there was never a row) so a
            // file that's since become genuinely importable doesn't keep carrying a skip record from before it
            // changed. Without this, getLocalImportSkip() would keep returning that stale row forever, even
            // though its own mtime-match gate means it can no longer actually SHORT-CIRCUIT anything - purely a
            // leftover, misleading record, not a functional bug on its own, but real hygiene debt every corpus
            // edit-in-place would accumulate.
            try {
                await clearLocalImportSkip(directories, sourcePath);
            } catch (clearErr) {
                console.debug(`[local-import] Failed to clear stale local_import_skips record for ${sourcePath}:`, clearErr.message);
            }
        }

        const contentHash = pipelineResult.contentHash;

        // Everything from here down (dedup-check through the eventual write/import) is serialized per content
        // hash via withPerHashLock() (see that function's own doc comment) - concurrent worker dispatch (see
        // scanDirectory()'s mapWithConcurrency() call) means this section can now genuinely run for several
        // DIFFERENT files at once, and if two of those happen to share a content hash, the dedup-check-then-
        // import sequence below is a real TOCTOU race without this: both would find nothing imported yet, and
        // both would import. Files with different hashes are never blocked by each other. Note this is also
        // exactly why the worker (for a needsWrite:true pipelineResult) never writes anything on its own before
        // this lock resolves what to do - see local-import-worker.js's own header on the two-phase protocol
        // this depends on.
        await withPerHashLock(state, contentHash, async () => {
            // Cheap pre-copy dedup check: skip staging/writing entirely for a file already in the library.
            // Correctness of dedup does not depend on this alone - importCharacterFileHeadless() (the
            // charx/byaf/yaml path below) re-checks the same hash right before actually importing - this also
            // saves the reflink/hardlink/copy/write work for the common "rescanning a directory whose files are
            // already all imported" case.
            const alreadyImported = await findCharacterIdByContentHash(directories, contentHash);
            if (alreadyImported) {
                if (pipelineResult.needsWrite) await pipelineResult.finish({ type: 'no-write' });
                await maybeReflinkDuplicateTarget(sourcePath, alreadyImported, directories);
                // In-memory only, not persisted - see markProcessedInMemoryOnly()'s own doc comment on why a
                // duplicate match must never be treated as a durable, restart-surviving skip.
                markProcessedInMemoryOnly(state, filename, stat.mtimeMs);
                return;
            }

            // Expensive fallback (see this module's header): only reached once the cheap exact-byte check above
            // has already found nothing. identityHash was computed in the worker above, gated on the exact same
            // allowIdentityFallback flag already read on this thread before dispatch.
            if (allowIdentityFallback && pipelineResult.identityHash) {
                try {
                    const identityMatch = await findCharacterIdByContentIdentityHash(directories, pipelineResult.identityHash);
                    if (identityMatch) {
                        if (pipelineResult.needsWrite) await pipelineResult.finish({ type: 'no-write' });
                        await maybeReflinkDuplicateTarget(sourcePath, identityMatch, directories);
                        // In-memory only - same reasoning as the exact content_hash match above.
                        markProcessedInMemoryOnly(state, filename, stat.mtimeMs);
                        return;
                    }
                } catch (err) {
                    // Non-fatal: a failed identity check must not block an otherwise-normal import attempt
                    // below - worst case here is a missed dedup (the file gets imported as a new character),
                    // never data loss.
                    console.debug(`[local-import] Content-identity duplicate check failed for ${sourcePath} (will still attempt an ordinary import):`, err.message);
                }
            }

            if (pipelineResult.needsWrite) {
                // png/json - the worker owns the write (2026-08 worker-owned-write extension). Build the final
                // card data purely on THIS thread (fast/non-IO business logic - spec dispatch, sanitize,
                // Risu-sprite side effects, mint id) from the rawText the worker already parsed out of its own
                // single read/extraction, then hand the worker back the target path + final data so it can
                // finish extract/splice/encode/write reusing the SAME buffer/chunks it already has - no second
                // read of sourcePath, ever. See characters.js's buildPngImportData()/buildJsonImportData() -
                // the exact same pure logic importFromPng()/importFromJson() themselves use for the browser
                // `/import` route, just fed pre-parsed text instead of a staged file to re-read.
                const data = format === 'png'
                    ? buildPngImportData(pipelineResult.rawText, directories)
                    : buildJsonImportData(pipelineResult.rawText, directories);

                if (data === null) {
                    await pipelineResult.finish({ type: 'no-write' });
                    console.warn(`[local-import] Failed to import ${sourcePath} (unrecognized content or import error) - will retry next pass.`);
                } else {
                    const pngName = mintCharacterId(directories);
                    const destPath = path.join(directories.characters, `${pngName}.png`);
                    await pipelineResult.finish({ type: 'write', destPath, data });
                    await fireMetadataUpsertHook(directories, `${pngName}.png`, data, contentHash);
                    console.log(color.cyan(`[local-import] Imported ${sourcePath} as ${pngName}.png`));
                    if (tagImportSetting !== 2) {
                        try {
                            await seedCardTagsForSingleCharacter(directories, `${pngName}.png`);
                        } catch (err) {
                            console.warn(`[local-import] Failed to seed tags for ${pngName}.png:`, err.message);
                        }
                    }
                }
            } else {
                // charx/byaf/yaml - unchanged stage+import path (see local-import-worker.js's own header on why
                // these three formats are out of scope for the worker-owned write: real archive/YAML parsing
                // this worker has no reason to duplicate, and none of them reflink from a real per-file source
                // either way).
                const stagedPath = await stageFile(sourcePath);
                const result = await importCharacterFileHeadless(stagedPath, format, directories, {
                    userHandle: DEFAULT_USER.handle,
                    contentHash,
                });

                if (!result) {
                    console.warn(`[local-import] Failed to import ${sourcePath} (unrecognized content or import error) - will retry next pass.`);
                } else if ('duplicateOf' in result) {
                    console.debug(`[local-import] Skipped ${sourcePath} - duplicate of already-imported character ${result.duplicateOf}.`);
                } else {
                    console.log(color.cyan(`[local-import] Imported ${sourcePath} as ${result.fileName}.png`));
                    if (tagImportSetting !== 2) {
                        try {
                            await seedCardTagsForSingleCharacter(directories, `${result.fileName}.png`);
                        } catch (err) {
                            console.warn(`[local-import] Failed to seed tags for ${result.fileName}.png:`, err.message);
                        }
                    }
                }
            }

            await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
        });
    } catch (err) {
        // Logs the full Error (stack included), not just err.message - a message-only line like "Input must be
        // string" gives no way to tell which of several sanitize()/hash/parse calls in the import path actually
        // threw, which is exactly what made this bug hard to locate from the running server's output alone.
        console.error(`[local-import] Failed to process ${sourcePath}, will retry next pass:`, err);
        // Deliberately does NOT update lastSeenMtimeMs on failure, so a transient error (e.g. the file still
        // being written to when this pass caught it) gets retried on the next scan rather than skipped forever.
    }
}

/**
 * One full pass over one configured directory: lists it, then processFile()s every entry. Wrapped in
 * beginBatchImport()/endBatchImport() (same machinery a bulk drag-drop import already uses - see this module's
 * header) so a directory holding many files pays one SQLite transaction/watcher-suspension window for the whole
 * pass rather than one per file.
 *
 * Also sweeps for files removed since the LAST pass that saw them (as opposed to processFile()'s own ENOENT
 * branch, which only ever catches a file removed WITHIN this same pass, between readdir() listing it and
 * stat()'ing it - readdir() below simply never lists a file that was already gone before it ran, so
 * processFile() is never even called for it, and a durable local_import_skips/local_import_mtimes row for it
 * would otherwise survive forever - a real, ordinary occurrence for a corpus directory's normal churn, not an
 * edge case). Computed as "every filename lastSeenMtimeMs knows about that ISN'T in this pass's fresh readdir()
 * listing" - lastSeenMtimeMs already IS this state's "files we've seen and are tracking" set, so no separate
 * bookkeeping is needed to know what to check for absence.
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function scanDirectory(state, directories) {
    if (!fs.existsSync(state.sourceDir)) {
        console.warn(`[local-import] Configured directory does not exist, skipping this pass: ${state.sourceDir}`);
        return;
    }

    let entries;
    try {
        entries = await fsPromises.readdir(state.sourceDir);
    } catch (err) {
        console.error(`[local-import] Failed to list ${state.sourceDir}, will retry next pass:`, err.message);
        return;
    }

    await beginBatchImport(directories);
    try {
        const entrySet = new Set(entries);
        // Snapshotted before the main loop below, which mutates lastSeenMtimeMs as it goes - this sweep is only
        // ever about files this pass's own readdir() never saw at all, not ones the main loop below discovers
        // are newly-added.
        const previouslyTracked = [...state.lastSeenMtimeMs.keys()];
        for (const filename of previouslyTracked) {
            if (!entrySet.has(filename)) {
                await cleanupRemovedFile(state, directories, filename);
            }
        }

        // Bounded-concurrency dispatch, not a plain sequential loop: processFile()'s own CPU-bound work now
        // runs inside the worker pool (see ensureWorkerPool()), so driving it one file at a time here would
        // leave every worker but one idle. Concurrency is capped at the same resolveWorkerPoolSize() the pool
        // itself was created with - dispatching more files at once than there are workers to service them just
        // queues up inside the pool with no throughput benefit, while still growing the number of files whose
        // main-thread pre/post-worker DB work (stat, skip-check, dedup lookups, staging, import) is interleaved
        // at once for no reason. mapWithConcurrency() (util.js) is the same bounded-concurrency driver
        // characters-search-index.js's own I/O-bound file-read pass already uses - reused here rather than a
        // second implementation of "N in flight at once, preserve nothing about ordering that matters" (file
        // processing order was never significant - each file's outcome is independent of every other's).
        const tagImportSetting = readTagImportSetting(directories);
        await mapWithConcurrency(entries, resolveWorkerPoolSize(), filename => processFile(state, filename, directories, tagImportSetting));
    } finally {
        await endBatchImport(directories);
        // withPerHashLock()'s coordination is only ever needed to arbitrate races WITHIN one pass's concurrent
        // dispatch (see that function's own doc comment) - across passes, runScanCycle()'s self-pacing already
        // guarantees only one pass is ever in flight at a time, so nothing from a finished pass can still be
        // racing a later one. Clearing here keeps this Map's size bounded by "distinct hashes seen in the most
        // recent pass" rather than growing for the lifetime of a long-running server.
        state.hashLocks?.clear();
    }
}

/**
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 */
function startWatcherFor(state, directories) {
    if (state.watcher || !fs.existsSync(state.sourceDir)) return;

    try {
        state.watcher = fs.watch(state.sourceDir, (_eventType, filename) => {
            if (isWindowsOverflowSignal(filename)) {
                // See watch-overflow.js's own doc comment: on Windows, `filename === null` is ReadDirectoryChangesW's
                // buffer-overflow signal (with a rare, owner-accepted false-positive case) - trigger the next
                // full pass now instead of waiting out the rest of scanIntervalMs.
                triggerImmediateRescan();
                return;
            }
            if (!filename) return;

            const existingTimer = state.watchTimers.get(filename);
            if (existingTimer) clearTimeout(existingTimer);
            state.watchTimers.set(filename, setTimeout(() => {
                state.watchTimers.delete(filename);
                processFile(state, filename, directories, readTagImportSetting(directories)).catch(err => {
                    console.error(`[local-import] Watcher-triggered import failed for ${filename} (the periodic scan will retry it):`, err.message);
                });
            }, WATCH_DEBOUNCE_MS));
        });
        state.watcher.on('error', (err) => {
            // Same posture as character-metadata-db.js's watcher error handler: this is for an actual
            // watcher-level error (e.g. the directory itself being removed), not the silent-drop case (which is
            // undetectable from JS either way) - either way the periodic scan remains the source of truth.
            console.error(`[local-import] Directory watcher error for ${state.sourceDir} (the periodic scan remains the source of truth):`, err.message);
        });
    } catch (err) {
        console.error(`[local-import] Failed to start directory watcher for ${state.sourceDir} (the periodic scan remains the source of truth):`, err.message);
    }

    // Linux-only, entirely separate mechanism (see watch-overflow.js's own doc comment on why Windows piggybacks
    // on the fs.watch() callback above but Linux needs a dedicated watch) - never awaited, so a failure/delay
    // attaching it can't hold up startWatcherFor() itself; state.overflowWatch starts null and is filled in once
    // (if ever) this resolves.
    attachOverflowWatch(state.sourceDir, () => triggerImmediateRescan()).then(handle => {
        state.overflowWatch = handle;
    }).catch(() => {
        // attachOverflowWatch() itself never rejects (see its own doc comment - unavailable/failed always
        // resolves to null), this catch is only defense-in-depth against a future change to that contract.
    });
}

/**
 * @param {DirectoryScanState} state
 */
function stopWatcherFor(state) {
    if (state.watcher) {
        state.watcher.close();
        state.watcher = null;
    }
    if (state.overflowWatch) {
        state.overflowWatch.close();
        state.overflowWatch = null;
    }
    for (const timer of state.watchTimers.values()) clearTimeout(timer);
    state.watchTimers.clear();
}

/**
 * Warms one directory's DirectoryScanState.lastSeenMtimeMs from character-metadata-db.js's persisted
 * `local_import_mtimes` table (see that table's SCHEMA_SQL comment and lastSeenMtimeMs's own doc comment) -
 * called once per state, before its first pass, so a server restart doesn't force a full read+hash+dedup-check
 * of every unchanged file in the corpus. `allMtimes` is one bulk-loaded Map covering every configured directory
 * for this user (not just this one) - filtered here to this state's own sourceDir - so initializeLocalImportScan()
 * only pays for one SELECT total across however many directories are configured, not one per directory.
 * @param {DirectoryScanState} state
 * @param {Map<string, number>} allMtimes source_path -> mtimeMs, as returned by getAllLocalImportMtimes()
 */
function warmMtimeCache(state, allMtimes) {
    const prefix = state.sourceDir.endsWith(path.sep) ? state.sourceDir : state.sourceDir + path.sep;
    for (const [sourcePath, mtimeMs] of allMtimes) {
        if (!sourcePath.startsWith(prefix)) continue;
        state.lastSeenMtimeMs.set(path.basename(sourcePath), mtimeMs);
    }
}

/**
 * Runs one full pass over every configured directory, then - unless disposeLocalImportScan() has since been
 * called - schedules the NEXT pass `scanIntervalMs` after THIS one finishes, and recurses.
 *
 * Deliberately self-pacing rather than a fixed-rate `setInterval` (which is what this used to be): a fixed-rate
 * timer fires again on the wall clock regardless of whether the previous pass is still running, and for a
 * corpus the size of the owner's real one (~301,717 files, measured ~214 files/sec post the read-once fix -
 * i.e. ~23.5 minutes for one full pass) that is nowhere close to a 60-second default interval, so passes would
 * pile up concurrently forever with no idle time ever. Concretely, that's not just wasteful: two overlapping
 * scanDirectory() calls both wrap themselves in beginBatchImport()/endBatchImport() (character-metadata-db.js),
 * whose batch-mode guard is idempotent (a second concurrent beginBatchImport() call is a no-op against an
 * already-active batch) - so the FIRST pass's endBatchImport() would flush/reconcile/resume the watcher while
 * the SECOND pass is still mid-flight actively writing through the same batch state, and that second pass's own
 * endBatchImport() would then itself be a no-op (batch already cleared), silently skipping its own
 * flush/reconcile. A structural correctness bug on top of the wasted CPU, not just extra wasted CPU. Because
 * scanStates is only ever driven by this one recursive call chain, and the next pass is only ever scheduled
 * from a `.finally` that runs after the previous pass's promise has already settled, there is no code path
 * through which two passes can be in flight at once - no separate "is a scan running" flag is needed to prevent
 * it, it's true by construction.
 *
 * `scanIntervalMs` therefore means "wait this long after the PREVIOUS pass completes", not "fire every N ms
 * regardless" - same config key, same default, adapted semantics. For a fast-changing small corpus this is
 * indistinguishable from the old fixed-rate behavior (passes finish near-instantly, so the two are the same up
 * to rounding); it only diverges - correctly - once a pass takes longer than the configured interval.
 * @param {import('./users.js').UserDirectoryList} userDirectories
 * @param {number} scanIntervalMs
 * @returns {Promise<void>} Resolves once this one pass (not future rescheduled passes) completes - see
 * currentPassPromise/waitForCurrentScanPass() for why that's still exposed despite production never awaiting it.
 */
async function runScanCycle(userDirectories, scanIntervalMs) {
    capturedUserDirectories = userDirectories;
    capturedScanIntervalMs = scanIntervalMs;

    const pass = (async () => {
        for (const state of scanStates) {
            await scanDirectory(state, userDirectories).catch(err => {
                console.error(`[local-import] Periodic scan failed for ${state.sourceDir}:`, err);
            });
        }
    })();
    currentPassPromise = pass;
    await pass;

    if (disposed) return;
    scanTimeout = setTimeout(() => {
        runScanCycle(userDirectories, scanIntervalMs);
    }, scanIntervalMs);
    // Same reasoning as character-metadata-db.js's reconcileInterval: unref() so this timer is never the reason
    // the process can't exit.
    scanTimeout.unref?.();
}

/**
 * Resolves once the currently in-flight (or most recently completed, if none is in flight) full scan pass
 * finishes. Exists for tests/observability only - see currentPassPromise's own doc comment on why production
 * code never calls this: awaiting a pass over a large real corpus is exactly the boot-blocking behavior this
 * module no longer does.
 * @returns {Promise<void>}
 */
export async function waitForCurrentScanPass() {
    await currentPassPromise;
}

/**
 * Called from a watcher-overflow signal (see watch-overflow.js) to run the NEXT pass now instead of waiting out
 * the rest of `scanIntervalMs` - a pure latency optimization, same posture as everything else in that module.
 * Deliberately does NOT start a second pass on top of one already running: if `scanTimeout` isn't currently set,
 * a pass is either already in flight or this module was never initialized (disposed/never-started) - either
 * way there is nothing safe or useful to do here, since runScanCycle() itself is the only thing ever allowed to
 * schedule the next pass (see that function's own doc comment on why overlap is impossible by construction) and
 * starting a second, independent call chain here would reintroduce exactly that hazard for the sake of shaving
 * time off an already-imminent pass.
 */
function triggerImmediateRescan() {
    if (!scanTimeout || !capturedUserDirectories || capturedScanIntervalMs === null) return;
    clearTimeout(scanTimeout);
    scanTimeout = null;
    runScanCycle(capturedUserDirectories, capturedScanIntervalMs).catch(err => {
        console.error('[local-import] Overflow-triggered scan cycle crashed unexpectedly:', err);
    });
}

/**
 * Server-boot entry point, meant to be called once alongside character-metadata-db.js's
 * initializeMetadataStores() (see server-main.js). Reads `localImport.directories`/`enabled`/`scanIntervalMs`/
 * `watchEnabled` from config.yaml, warms each configured directory's mtime-skip cache from the persisted
 * `local_import_mtimes` table (warmMtimeCache()), starts (if enabled) one fs.watch per directory, and kicks off
 * the self-pacing scan cycle (runScanCycle()) covering every configured directory.
 *
 * Deliberately does NOT await that scan cycle's first pass before returning: the OLD synchronous-initial-scan
 * behavior meant server-main.js's `preSetupTasks()` - which this is awaited from, and which itself gates the
 * server ever calling `listen()` - blocked server startup entirely on a full pass over whatever's configured,
 * which for the owner's real ~301,717-file corpus measures ~23.5 minutes on EVERY restart, cold-cache or not.
 * This mirrors initializeMetadataStores()'s own already-established precedent one call above this one in
 * preSetupTasks() ("Deliberately not awaited beyond schema creation... a large library's bootstrap backfill must
 * never delay the server actually starting to listen") - the same reasoning applies here, just to a different
 * subsystem's boot-time backfill. Tests that need to observe the initial pass's result use
 * waitForCurrentScanPass().
 *
 * A no-op (and never touches `directories`, uploads, or the watcher) when `enabled` is false or the configured
 * `directories` list is empty - this feature is entirely inert on an install that hasn't opted into it.
 * @returns {Promise<void>}
 */
export async function initializeLocalImportScan() {
    disposeLocalImportScan(); // Idempotent re-init, same convention as re-running this at boot would need.
    disposed = false;

    const enabled = getConfigValue('localImport.enabled', true, 'boolean');
    const directories = getConfigValue('localImport.directories', [], null);
    const scanIntervalMs = getConfigValue('localImport.scanIntervalMs', 60 * 1000, 'number');
    const watchEnabled = getConfigValue('localImport.watchEnabled', true, 'boolean');

    if (!enabled || !Array.isArray(directories) || directories.length === 0) {
        return;
    }

    const userDirectories = getUserDirectories(DEFAULT_USER.handle);

    scanStates = directories.map(sourceDir => ({
        sourceDir,
        lastSeenMtimeMs: new Map(),
        watcher: null,
        watchTimers: new Map(),
        overflowWatch: null,
    }));

    const allMtimes = await getAllLocalImportMtimes(userDirectories);
    for (const state of scanStates) {
        warmMtimeCache(state, allMtimes);
        if (watchEnabled) {
            startWatcherFor(state, userDirectories);
        }
    }

    // Created eagerly here (rather than left to ensureWorkerPool()'s own lazy-create-on-first-use path) so the
    // pool's lifetime is explicitly tied to this scan lifecycle from the start, same as every other resource
    // this function sets up (watchers, scanStates) - disposeLocalImportScan() is this function's exact
    // counterpart and is what actually tears it back down (see that function).
    ensureWorkerPool();

    // Not awaited - see this function's own doc comment on why the initial pass must never block server startup.
    runScanCycle(userDirectories, scanIntervalMs).catch(err => {
        console.error('[local-import] Scan cycle crashed unexpectedly:', err);
    });
}

/**
 * Graceful-shutdown / test-teardown counterpart to initializeLocalImportScan(): closes every watcher, tells any
 * in-flight scan cycle to stop rescheduling itself once its current pass finishes, clears the pending
 * reschedule timer if one is set, and tears down the worker pool (see LocalImportWorkerPool.dispose()) so no
 * worker thread outlives this scan's lifecycle - across a scan-config re-init (initializeLocalImportScan()
 * calls this first) or an actual server shutdown alike. Mirrors character-metadata-db.js's
 * disposeMetadataStores().
 */
export function disposeLocalImportScan() {
    disposed = true;
    for (const state of scanStates) {
        stopWatcherFor(state);
    }
    scanStates = [];
    currentPassPromise = null;
    capturedUserDirectories = null;
    capturedScanIntervalMs = null;
    if (scanTimeout) {
        clearTimeout(scanTimeout);
        scanTimeout = null;
    }
    if (workerPool) {
        // Not awaited - disposeLocalImportScan() has always been a synchronous, fire-and-forget teardown (same
        // convention stopWatcherFor()'s callers already rely on), and every worker here is already .unref()'d
        // (see LocalImportWorkerPool._spawnSlot()) so a still-terminating worker can never be the reason this
        // process/test fails to exit. The pool reference is cleared immediately so the very next
        // ensureWorkerPool() call (e.g. from initializeLocalImportScan() re-initializing right after this)
        // always gets a fresh pool rather than the one already mid-teardown.
        const poolToDispose = workerPool;
        workerPool = null;
        poolToDispose.dispose().catch(err => {
            console.error('[local-import] Worker pool disposal failed:', err);
        });
    }
}
