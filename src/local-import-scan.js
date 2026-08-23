import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import yaml from 'yaml';

import { getConfigValue, color } from './util.js';
import { DEFAULT_USER, UPLOADS_DIRECTORY } from './constants.js';
import { getUserDirectories } from './users.js';
import { copyCharacterFile, hardlinkOntoCanonical } from './local-import-copy.js';
import { importCharacterFileHeadless } from './endpoints/characters.js';
import { beginBatchImport, endBatchImport, findCharacterIdByContentHash, findCharacterIdByContentIdentityHash, computeContentIdentityHash, getLocalImportSkip, setLocalImportSkip, clearLocalImportSkip, getAllLocalImportMtimes, setLocalImportMtime, clearLocalImportMtime } from './character-metadata-db.js';
import { read as readCharacterCard } from './character-card-parser.js';
import { getCharaCardV2, convertToV2 } from './character-card-normalize.js';
import { attachOverflowWatch, isWindowsOverflowSignal } from './watch-overflow.js';

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
 * DISCOVERED-FILE IMPORT reuses the exact same batched/hash-dedup machinery `/import` and its
 * `/metadata/batch-import/begin|end` counterparts already use for a browser bulk drag-drop import, rather than
 * a parallel implementation of it - a directory scan bringing in many files at once is the same shape of bulk
 * operation:
 *   - copyCharacterFile() (local-import-copy.js) stages the discovered file's bytes into this install's normal
 *     uploads directory (the same directory multer stages a browser upload into) via reflink/hardlink where the
 *     filesystem allows it, falling back to a full copy only if configured to
 *   - importCharacterFileHeadless() (characters.js) drives that staged copy through the identical
 *     format-dispatch table, hash-based exact-duplicate dedup, and writeCharacterData()/metadata-upsert path
 *     `POST /import` uses
 *   - beginBatchImport()/endBatchImport() wrap each scan pass, so a directory holding many files pays one
 *     SQLite transaction/watcher-suspension window per pass instead of one per file, identical to what a bulk
 *     drag-drop import already gets
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

/** Extension (lowercase, no dot) -> format key accepted by characters.js's formatImportFunctions dispatch table.
 * Deliberately the full set `/import` recognizes (see that route), not a subset - a locally-dropped file is no
 * less legitimate a source than a browser upload of the same format. */
const EXTENSION_TO_FORMAT = {
    png: 'png',
    json: 'json',
    charx: 'charx',
    byaf: 'byaf',
    yaml: 'yaml',
    yml: 'yml',
};

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

/**
 * @param {string} filename
 * @returns {string | null} A formatImportFunctions key, or null if this filename isn't a recognized character
 * file format at all (e.g. a stray .txt or .DS_Store dropped into a watched directory) - such files are silently
 * ignored, not an error, since a watched directory isn't guaranteed to contain only character files.
 */
function detectFormat(filename) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    return EXTENSION_TO_FORMAT[ext] ?? null;
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
 * When `localImport.hardlinkDuplicateSourceFiles` is enabled (default `false` - see that key's own doc
 * comment in config.yaml), replaces a duplicate source file in place with a hardlink to the canonical
 * already-imported character file, so the scanned source directory itself gets deduplicated on disk over
 * time - not just avoided-as-a-redundant-character-record. A no-op whenever the toggle is off, so a
 * directory the user only configured as an import SOURCE is never mutated without that explicit opt-in.
 *
 * Safety posture: `contentHash` is the exact same sha256 `processFile()` already used to confirm this file
 * is a duplicate via `findCharacterIdByContentHash()`'s lookup against the `content_hash` column - that
 * lookup already IS the byte-identity confirmation this feature relies on, and this function reuses it as
 * given rather than re-deriving equality some other, looser way (e.g. comparing file size or mtime).
 *
 * Deliberately does NOT additionally re-hash `targetPath`'s current on-disk bytes and compare those to
 * `contentHash` - the two are never expected to match even for a completely legitimate, correctly-detected
 * duplicate: `content_hash` records the hash of the raw bytes as originally UPLOADED (see that column's own
 * doc comment in character-metadata-db.js), while every importFromX() in characters.js writes fresh
 * metadata into the stored character file as part of import (e.g. a freshly-generated `create_date`), so
 * the canonical character file's current bytes differ from its own original upload's bytes too, by design -
 * re-hashing `targetPath` and requiring a match would therefore reject every real duplicate, not catch bad
 * ones. What this DOES still check below is that `targetPath` actually exists - a stale/inconsistent DB
 * record (character row present, file since deleted by other means) is a real possibility this feature
 * must not crash on, and is a different question from "is the match real."
 * @param {string} sourcePath Absolute path to the duplicate source file (already confirmed to exist by the caller).
 * @param {string} characterId The already-imported character's id, as returned by findCharacterIdByContentHash() -
 * this is the character's full avatar FILENAME (e.g. `01a0....png`, already including the `.png` extension -
 * see character-metadata-db.js's buildRow()/upsertCharacterFromWrite() doc comments on `id` being the avatar
 * filename, not a bare id), so it is joined onto `directories.characters` as-is, not with another `.png` appended.
 * @param {string} contentHash sha256 hex digest already computed for `sourcePath` by the caller - unused
 * directly here (the match was already made by the caller's findCharacterIdByContentHash() lookup), kept as
 * a parameter only so a future caller-side change to what identifies "the match" doesn't have to also touch
 * this function's signature.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>} Never throws - every failure/inapplicable-case is logged and swallowed, since
 * this is always a secondary disk-space optimization layered on top of an import that already succeeded.
 */
async function maybeHardlinkDuplicateSource(sourcePath, characterId, contentHash, directories) {
    const hardlinkEnabled = getConfigValue('localImport.hardlinkDuplicateSourceFiles', false, 'boolean');
    if (!hardlinkEnabled) return;

    const targetPath = path.join(directories.characters, characterId);

    let targetStat;
    try {
        targetStat = await fsPromises.stat(targetPath);
    } catch (err) {
        console.warn(`[local-import] Duplicate-source hardlink skipped for ${sourcePath}: canonical character file ${targetPath} does not exist (stale record?).`);
        return;
    }
    if (!targetStat.isFile()) return;

    try {
        const sourceStat = await fsPromises.stat(sourcePath);
        if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
            return; // Already the same inode (e.g. a prior pass already linked these) - nothing to do.
        }

        await hardlinkOntoCanonical(sourcePath, targetPath);
        console.log(color.cyan(`[local-import] Deduplicated source file on disk: ${sourcePath} -> hardlinked to ${targetPath}.`));
    } catch (err) {
        if (err.code === 'EXDEV') {
            console.debug(`[local-import] Duplicate-source hardlink skipped for ${sourcePath}: source directory and characters directory are on different filesystems.`);
            return;
        }
        console.error(`[local-import] Failed to hardlink duplicate source ${sourcePath} onto ${targetPath}, leaving source file untouched:`, err.message);
    }
}

/**
 * Non-destructively parses `sourceBuffer` (the source file's bytes, already read once by the caller - never
 * written to, never staged, never consumed) into the same normalized shape computeContentIdentityHash() always
 * hashes from, and returns that hash - or `null` for a format this doesn't (yet) know how to parse without
 * importing it.
 *
 * Takes the already-read buffer rather than a path/re-reading it from disk: `processFile()` (the only caller)
 * already reads `sourcePath` in full to compute `contentHash` via sha256 - re-reading the identical bytes here a
 * second time (this used to call parseCharacterCard()/fsPromises.readFile() directly on the path) was a second
 * full disk read of every newly-discovered file for no reason, measured as a real contributor to this module's
 * throughput on the owner's ~300k-file real-world scan (2026-08 local-import perf investigation) - the same
 * "redo expensive per-item work instead of computing it once" shape as the tags.json bug bootstrapIfNeeded() had.
 *
 * PNG and JSON are the trivial cases: readCharacterCard()/JSON.parse() + getCharaCardV2() is exactly the
 * read-off-disk-without-importing pattern character-metadata-db.js's bootstrapIfNeeded()/reconcile() already use
 * to build a metadata row from an arbitrary on-disk card - reused here rather than duplicated. YAML/YML reuses
 * convertToV2() with the same field-shaping importFromYaml() (characters.js) does, minus the actual write - safe
 * to call standalone because the YAML import path never populates `world` on the object it builds (the only
 * field that would make charaFormatData() do its own file I/O, via readWorldInfoFile()).
 *
 * CharX and BYAF are deliberately NOT handled here (return `null`, meaning "no fallback match attempted, fall
 * through to normal import") - punted as an explicit follow-up. Their only existing parsers (byaf.js's
 * ByafParser, charx.js's CharXParser) are entangled with the actual import/asset-persistence flow, not factored
 * out into a standalone non-destructive read the way PNG/JSON/YAML's normalization already was; pulling that
 * apart safely is a real untangling job, not a small extraction, and out of scope here. This only means the
 * *poisoned-row-vs-byte-different* case goes undetected for these two formats - the content_hash exact-byte fast
 * path above still fully covers a byte-identical re-drop of a charx/byaf file either way, and an undetected
 * semantic duplicate here is a false NEGATIVE (a duplicate slips through and gets imported again), never a false
 * positive - see this module's own header on why that's the safe direction to err in.
 * @param {Buffer} sourceBuffer The source file's raw bytes, already read by the caller.
 * @param {string} format A formatImportFunctions key (see EXTENSION_TO_FORMAT)
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<string | null>}
 */
async function computeCandidateContentIdentityHash(sourceBuffer, format, directories) {
    switch (format) {
        case 'png': {
            const imgData = readCharacterCard(sourceBuffer);
            if (imgData === undefined) return null;
            const character = getCharaCardV2(JSON.parse(imgData), directories, false);
            return computeContentIdentityHash(character);
        }
        case 'json': {
            const raw = sourceBuffer.toString('utf8');
            const character = getCharaCardV2(JSON.parse(raw), directories, false);
            return computeContentIdentityHash(character);
        }
        case 'yaml':
        case 'yml': {
            const raw = sourceBuffer.toString('utf8');
            const yamlData = yaml.parse(raw);
            // Mirrors importFromYaml()'s (characters.js) own field-shaping object, minus everything that
            // function does AFTER building it (sanitize(), writeCharacterData(), the returned file name) - this
            // is only ever used to compute a hash, nothing here is persisted.
            const shaped = convertToV2({
                name: yamlData.name,
                description: yamlData.context ?? '',
                first_mes: yamlData.greeting ?? '',
                create_date: new Date().toISOString(),
                chat: '',
                personality: '',
                creatorcomment: '',
                avatar: 'none',
                mes_example: '',
                scenario: '',
                talkativeness: 0.5,
                creator: '',
                tags: '',
            }, directories);
            return computeContentIdentityHash(shaped);
        }
        default:
            // charx/byaf (or anything else EXTENSION_TO_FORMAT maps to that isn't handled above) - see this
            // function's own doc comment.
            return null;
    }
}

/**
 * Cheap, non-destructive pre-check for a `.json`-extension candidate - run BEFORE any staging/import machinery
 * touches the file, so it can tell "this file's content will never be a character card" apart from "the import
 * pipeline itself failed on it for some other reason" (see processFile()'s own comment on why that distinction
 * is what decides retry-forever vs skip-once). Two real corpus-hygiene shapes get recognized here, both drawn
 * from an actual owner-reported case (see local-import-scan.test.js):
 *   - 'not-json': the bytes aren't valid JSON at all - e.g. a PNG file that got misnamed/mislabeled with a
 *     `.json` extension.
 *   - 'unrecognized-shape': valid JSON, but not any of the three shapes importFromJson() (characters.js)
 *     actually dispatches on (ccv2/v3's top-level `spec`, v1's `name`, or Pygmalion's `char_name`) - deliberately
 *     mirrors that function's own dispatch conditions exactly, rather than a separate/looser notion of "looks
 *     like a card", so this can never disagree with what importFromJson() would actually have done. e.g. a
 *     lorebook/world-info export that happens to sit in the same corpus directory as real character cards.
 * Returns `null` for anything else - including a shape this function doesn't specifically recognize but that
 * importFromJson() might still handle - meaning "don't pre-emptively skip, let the normal import attempt run
 * and speak for itself".
 * @param {Buffer} sourceBuffer The source file's raw bytes, already read by the caller.
 * @returns {'not-json' | 'unrecognized-shape' | null}
 */
function classifyJsonCandidate(sourceBuffer) {
    let parsed;
    try {
        parsed = JSON.parse(sourceBuffer.toString('utf8'));
    } catch {
        return 'not-json';
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'unrecognized-shape';
    }

    // Mirrors importFromJson()'s (characters.js) own dispatch conditions exactly - see that function.
    if (parsed.spec !== undefined || parsed.name !== undefined || parsed.char_name !== undefined) {
        return null;
    }

    return 'unrecognized-shape';
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

async function processFile(state, filename, directories) {
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

    try {
        // Read the source file's bytes exactly once and reuse the buffer for both the sha256 dedup hash below
        // and (on the expensive-fallback path further down) the content-identity parse - the fast path used to
        // call hashFileContents(sourcePath) (a stream read) and then, on the fallback path, re-read the same
        // path a second time from disk via parseCharacterCard()/fsPromises.readFile(). Two full reads of every
        // newly-discovered file's bytes for no reason - the same "redo expensive per-item work instead of
        // computing it once" shape as the tags.json bug bootstrapIfNeeded() had, measured as a real contributor
        // to this module's throughput on the owner's ~300k-file real-world scan (2026-08 local-import perf
        // investigation). A plain buffered read (not a stream) also means one read syscall for a typical
        // multi-MB card instead of the dozens a 64KB-chunked ReadStream issued.
        const sourceBuffer = await fsPromises.readFile(sourcePath);

        // Permanent-skip classification (see classifyJsonCandidate()'s own doc comment): runs on the raw bytes
        // alone, before any staging/import machinery is touched, so it can never be confused with - or mask - a
        // real failure IN that machinery. Only ever short-circuits format 'json' candidates that are positively
        // determined here to be either not valid JSON at all, or valid JSON that isn't a recognized character-
        // card shape; everything else (including every other format, and any json this doesn't recognize as
        // one of those two failure shapes) falls through to the exact same import attempt as before, which
        // keeps its own existing retry-on-failure behavior for genuinely transient problems untouched.
        if (format === 'json') {
            const classification = classifyJsonCandidate(sourceBuffer);
            if (classification) {
                const reasonText = classification === 'not-json'
                    ? 'not valid JSON (the content does not look like a character card - possibly a misnamed/mislabeled file, e.g. an image saved with a .json extension)'
                    : 'valid JSON but not a recognized character card shape (no spec/name/char_name field - likely a lorebook/world-info export or other non-character JSON)';
                console.warn(color.yellow(`[local-import] Permanently skipping ${sourcePath}: ${reasonText}. Will not retry unless the file changes.`));
                await setLocalImportSkip(directories, sourcePath, stat.mtimeMs, classification);
                await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
                return;
            }

            // Reaching here for a .json candidate means: this file is NOT skip-worthy at its current bytes -
            // either it never was, or (the case this specifically guards) it WAS previously skip-classified at
            // an older mtime and has since been edited into something classifyJsonCandidate() no longer
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

        const contentHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');

        // Cheap pre-copy dedup check: skip staging entirely for a file already in the library. Correctness of
        // dedup does not depend on this - importCharacterFileHeadless() re-checks the same hash right before
        // actually importing - this only saves the reflink/hardlink/copy work for the common "rescanning a
        // directory whose files are already all imported" case.
        const alreadyImported = await findCharacterIdByContentHash(directories, contentHash);
        if (alreadyImported) {
            await maybeHardlinkDuplicateSource(sourcePath, alreadyImported, contentHash, directories);
            // In-memory only, not persisted - see markProcessedInMemoryOnly()'s own doc comment on why a
            // duplicate match must never be treated as a durable, restart-surviving skip.
            markProcessedInMemoryOnly(state, filename, stat.mtimeMs);
            return;
        }

        // Expensive fallback (see this module's header): only reached once the cheap exact-byte check above has
        // already found nothing. Read fresh via getConfigValue() (not the module-level cached export in
        // character-metadata-db.js) so this reflects a config/env change on the very next scan pass - see that
        // export's own updated doc comment for why.
        if (getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean')) {
            try {
                const identityHash = await computeCandidateContentIdentityHash(sourceBuffer, format, directories);
                const identityMatch = identityHash ? await findCharacterIdByContentIdentityHash(directories, identityHash) : null;
                if (identityMatch) {
                    // Same treatment as an exact content_hash match above - a real content-hash value is still
                    // passed through to maybeHardlinkDuplicateSource() (it only ever gates on the config flag,
                    // never inspects the hash's own value - see that function's doc comment), so the on-disk
                    // dedup behavior is identical either way.
                    await maybeHardlinkDuplicateSource(sourcePath, identityMatch, contentHash, directories);
                    // In-memory only - same reasoning as the exact content_hash match above.
                    markProcessedInMemoryOnly(state, filename, stat.mtimeMs);
                    return;
                }
            } catch (err) {
                // Non-fatal: a failed identity check must not block an otherwise-normal import attempt below -
                // worst case here is a missed dedup (the file gets imported as a new character), never data loss.
                console.debug(`[local-import] Content-identity duplicate check failed for ${sourcePath} (will still attempt an ordinary import):`, err.message);
            }
        }

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
        }

        await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
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

        for (const filename of entries) {
            await processFile(state, filename, directories);
        }
    } finally {
        await endBatchImport(directories);
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
                processFile(state, filename, directories).catch(err => {
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

    // Not awaited - see this function's own doc comment on why the initial pass must never block server startup.
    runScanCycle(userDirectories, scanIntervalMs).catch(err => {
        console.error('[local-import] Scan cycle crashed unexpectedly:', err);
    });
}

/**
 * Graceful-shutdown / test-teardown counterpart to initializeLocalImportScan(): closes every watcher, tells any
 * in-flight scan cycle to stop rescheduling itself once its current pass finishes, and clears the pending
 * reschedule timer if one is set. Mirrors character-metadata-db.js's disposeMetadataStores().
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
}
