import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { getConfigValue, color } from './util.js';
import { DEFAULT_USER, UPLOADS_DIRECTORY } from './constants.js';
import { getUserDirectories } from './users.js';
import { copyCharacterFile } from './local-import-copy.js';
import { hashFileContents, importCharacterFileHeadless } from './endpoints/characters.js';
import { beginBatchImport, endBatchImport, findCharacterIdByContentHash } from './character-metadata-db.js';

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
 * wasteful, so a cold-started (in-memory, not persisted) cache losing its state on restart is harmless.
 * @property {fs.FSWatcher | null} watcher
 * @property {Map<string, NodeJS.Timeout>} watchTimers Per-filename debounce timers, mirrors
 * character-metadata-db.js's watchTimers.
 */

/** @type {DirectoryScanState[]} */
let scanStates = [];
/** @type {NodeJS.Timeout | null} */
let scanInterval = null;

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
 * Discovers-and-imports one file if it looks new/changed and isn't already in the library (by content hash).
 * Shared by both the periodic scan and the (optional) fs.watch handler - see this module's header on why there
 * is only ever one such code path.
 * @param {DirectoryScanState} state
 * @param {string} filename
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
async function processFile(state, filename, directories) {
    const format = detectFormat(filename);
    if (!format) return;

    const sourcePath = path.join(state.sourceDir, filename);
    let stat;
    try {
        stat = await fsPromises.stat(sourcePath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            state.lastSeenMtimeMs.delete(filename);
            return; // Removed between listing and stat'ing, or a watcher event for a since-deleted file.
        }
        throw err;
    }

    if (!stat.isFile()) return;

    if (state.lastSeenMtimeMs.get(filename) === stat.mtimeMs) {
        return; // Unchanged since the last pass that processed it - see lastSeenMtimeMs's own doc comment.
    }

    try {
        const contentHash = await hashFileContents(sourcePath);

        // Cheap pre-copy dedup check: skip staging entirely for a file already in the library. Correctness of
        // dedup does not depend on this - importCharacterFileHeadless() re-checks the same hash right before
        // actually importing - this only saves the reflink/hardlink/copy work for the common "rescanning a
        // directory whose files are already all imported" case.
        const alreadyImported = await findCharacterIdByContentHash(directories, contentHash);
        if (alreadyImported) {
            state.lastSeenMtimeMs.set(filename, stat.mtimeMs);
            return;
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

        state.lastSeenMtimeMs.set(filename, stat.mtimeMs);
    } catch (err) {
        console.error(`[local-import] Failed to process ${sourcePath}, will retry next pass:`, err.message);
        // Deliberately does NOT update lastSeenMtimeMs on failure, so a transient error (e.g. the file still
        // being written to when this pass caught it) gets retried on the next scan rather than skipped forever.
    }
}

/**
 * One full pass over one configured directory: lists it, then processFile()s every entry. Wrapped in
 * beginBatchImport()/endBatchImport() (same machinery a bulk drag-drop import already uses - see this module's
 * header) so a directory holding many files pays one SQLite transaction/watcher-suspension window for the whole
 * pass rather than one per file.
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
}

/**
 * @param {DirectoryScanState} state
 */
function stopWatcherFor(state) {
    if (state.watcher) {
        state.watcher.close();
        state.watcher = null;
    }
    for (const timer of state.watchTimers.values()) clearTimeout(timer);
    state.watchTimers.clear();
}

/**
 * Server-boot entry point, meant to be called once alongside character-metadata-db.js's
 * initializeMetadataStores() (see server-main.js). Reads `localImport.directories`/`enabled`/`scanIntervalMs`/
 * `watchEnabled` from config.yaml, starts one periodic-scan interval covering every configured directory plus
 * (if enabled) one fs.watch per directory, and runs one scan pass immediately rather than waiting for the first
 * interval tick.
 *
 * A no-op (and never touches `directories`, uploads, or the watcher) when `enabled` is false or the configured
 * `directories` list is empty - this feature is entirely inert on an install that hasn't opted into it.
 * @returns {Promise<void>}
 */
export async function initializeLocalImportScan() {
    disposeLocalImportScan(); // Idempotent re-init, same convention as re-running this at boot would need.

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
    }));

    for (const state of scanStates) {
        if (watchEnabled) {
            startWatcherFor(state, userDirectories);
        }
        await scanDirectory(state, userDirectories).catch(err => {
            console.error(`[local-import] Initial scan failed for ${state.sourceDir}:`, err);
        });
    }

    scanInterval = setInterval(() => {
        for (const state of scanStates) {
            scanDirectory(state, userDirectories).catch(err => {
                console.error(`[local-import] Periodic scan failed for ${state.sourceDir}:`, err);
            });
        }
    }, scanIntervalMs);
    // Same reasoning as character-metadata-db.js's reconcileInterval: unref() so this timer is never the reason
    // the process can't exit.
    scanInterval.unref?.();
}

/**
 * Graceful-shutdown / test-teardown counterpart to initializeLocalImportScan(): closes every watcher and clears
 * the scan interval. Mirrors character-metadata-db.js's disposeMetadataStores().
 */
export function disposeLocalImportScan() {
    for (const state of scanStates) {
        stopWatcherFor(state);
    }
    scanStates = [];
    if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
    }
}
