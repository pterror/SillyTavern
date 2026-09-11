import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

import { getConfigValue, color, mapWithConcurrency } from './util.js';
import { DEFAULT_USER, UPLOADS_DIRECTORY } from './constants.js';
import { getUserDirectories } from './users.js';
import { readSettingsAtPaths } from './settings-store.js';
import { copyCharacterFile } from './local-import-copy.js';
import { importCharacterFileHeadless, buildPngImportData, buildJsonImportData, mintCharacterId, fireMetadataUpsertHook } from './endpoints/characters.js';
import { beginBatchImport, endBatchImport, findCharacterIdByContentHash, findCharacterIdByContentIdentityHash, getLocalImportSkip, setLocalImportSkip, clearLocalImportSkip, getLocalImportMtime, getLocalImportMtimesForPaths, getLocalImportMtimeSourcePathsAfter, setLocalImportMtime, clearLocalImportMtime, setCharacterDateAdded, seedCardTagsForSingleCharacter } from './character-metadata-db.js';
import { attachLinuxDirectoryWatch, isWindowsOverflowSignal } from './watch-overflow.js';
import { detectFormat } from './local-import-classify.js';
import { LocalImportWorkerPool, resolveWorkerPoolSize } from './local-import-worker-pool.js';

/**
 * Imports characters from directories listed under `localImport.directories` in config.yaml. This module never
 * accepts a directory path from a request, so it's never an arbitrary-path-read endpoint.
 *
 * Two discovery mechanisms feed the same per-file import logic: a periodic full-corpus scan (scanDirectory(),
 * the backstop) and an optional fs.watch/inotify watch (startWatcherFor()) that's purely a latency optimization,
 * since a dropped watch event is otherwise undetectable from JS. On Linux, a native watch
 * (attachLinuxDirectoryWatch()) also detects kernel-side overflow directly; once every configured directory has
 * that confirmed, the periodic full pass is replaced by a cheap heartbeat probe (checkWatcherHeartbeat()) that
 * falls back to a full pass on any miss.
 *
 * png/json imports are done entirely by the worker pool (local-import-worker.js), including the write, reusing
 * buildPngImportData()/buildJsonImportData() from the browser `/import` path. charx/byaf/yaml are staged into
 * the uploads directory and imported via importCharacterFileHeadless(), unchanged from before the worker pool.
 *
 * Single-user only: every discovered file lands in DEFAULT_USER's library regardless of `enableUserAccounts`.
 *
 * `performance.allowExpensiveDuplicateFallback` additionally matches a newly-discovered file against already-
 * imported (including previously content-mutating-imported/"poisoned") characters by content-identity hash, not
 * just exact byte hash, since a poisoned row's content_hash isn't comparable to a fresh import's.
 */

/** Debounce window for coalescing bursts of fs events for the same filename into one scan. */
const WATCH_DEBOUNCE_MS = 300;

/** Ceiling on DirectoryScanState.lastSeenMtimeMs; LRU-evicted (Map insertion order = LRU order). A cache miss
 * past this falls back to a cheap indexed SELECT, so exceeding it costs latency, never correctness. */
export const MAX_LAST_SEEN_MTIME_ENTRIES = 200_000;

/**
 * @param {DirectoryScanState} state
 * @param {string} filename
 * @param {number} mtimeMs
 */
export function touchLastSeenMtime(state, filename, mtimeMs) {
    state.lastSeenMtimeMs.delete(filename);
    if (state.lastSeenMtimeMs.size >= MAX_LAST_SEEN_MTIME_ENTRIES) {
        const oldest = state.lastSeenMtimeMs.keys().next().value;
        state.lastSeenMtimeMs.delete(oldest);
    }
    state.lastSeenMtimeMs.set(filename, mtimeMs);
}

/**
 * @typedef {object} DirectoryScanState
 * @property {string} sourceDir
 * @property {Map<string, number>} lastSeenMtimeMs Skip-cache only, never relied on for correctness - content-hash
 * dedup makes reprocessing always safe. Bounded (MAX_LAST_SEEN_MTIME_ENTRIES); misses fall back to the persisted
 * `local_import_mtimes` table.
 * @property {fs.FSWatcher | { close: () => void } | null} watcher
 * @property {boolean} [watcherStarting] Guards the async gap in startWatcherFor() against a second concurrent call.
 * @property {Map<string, NodeJS.Timeout>} watchTimers
 * @property {{ close: () => void } | null} overflowWatch Non-null means overflow detection is confirmed live for
 * this directory. On Linux with the native watch attached, this is a no-op-close marker (not a second handle to
 * the same underlying watcher) so stopWatcherFor() never double-closes it.
 * @property {Map<string, () => void>} pendingHeartbeats
 * @property {Map<string, Promise<void>>} [hashLocks] Lazily created.
 * @property {Map<string, Promise<void>>} [inFlightFiles] Lazily created.
 */

/**
 * @returns {boolean}
 */
function allOverflowConfirmed() {
    return scanStates.length > 0 && scanStates.every(state => state.overflowWatch !== null);
}

/** How often checkWatcherHeartbeat() runs once allOverflowConfirmed() is true, replacing the periodic full pass. */
const HEARTBEAT_INTERVAL_MS = getConfigValue('localImport.watcherHeartbeatIntervalMs', 60 * 1000, 'number');

/** Deliberately generous: a false "stalled" verdict just costs one extra full pass, a false "alive" verdict
 * costs real undetected coverage. */
const HEARTBEAT_GRACE_MS = getConfigValue('localImport.watcherHeartbeatGraceMs', 15 * 1000, 'number');

/**
 * @param {DirectoryScanState} state
 * @returns {Promise<boolean>}
 */
async function checkWatcherHeartbeat(state) {
    if (!state.watcher) return false;

    const filename = `.st-heartbeat-${crypto.randomUUID()}.heartbeat`;
    const sentinelPath = path.join(state.sourceDir, filename);

    const observed = await new Promise((resolve) => {
        const timer = setTimeout(() => {
            state.pendingHeartbeats.delete(filename);
            resolve(false);
        }, HEARTBEAT_GRACE_MS);
        timer.unref?.();

        state.pendingHeartbeats.set(filename, () => {
            clearTimeout(timer);
            resolve(true);
        });

        fsPromises.writeFile(sentinelPath, '').catch(() => {
            clearTimeout(timer);
            state.pendingHeartbeats.delete(filename);
            resolve(false);
        });
    });

    await fsPromises.unlink(sentinelPath).catch((err) => {
        if (err.code !== 'ENOENT') {
            console.debug(`[local-import] Failed to remove heartbeat sentinel ${sentinelPath}:`, err.message);
        }
    });

    return observed;
}

/** @type {DirectoryScanState[]} */
let scanStates = [];
/** @type {NodeJS.Timeout | null} */
let scanTimeout = null;
/** @type {import('./users.js').UserDirectoryList | null} Captured at init so triggerImmediateRescan() can reach
 * the same arguments runScanCycle() needs. */
let capturedUserDirectories = null;
/** @type {number | null} */
let capturedScanIntervalMs = null;
/** Tells an in-flight scan cycle to stop rescheduling itself once its current pass finishes. */
let disposed = false;
/** True for the duration of an actual runScanCycle() pass. Without this, triggerImmediateRescan() could launch a
 * second concurrent runScanCycle() (checking stale `scanTimeout` truthiness isn't enough - it's never cleared
 * when a normally-scheduled timer fires), corrupting shared beginBatchImport()/endBatchImport() batch state. */
let passInFlight = false;
/** @type {Promise<void> | null} Exported via waitForCurrentScanPass() for tests only - production never awaits it. */
let currentPassPromise = null;
/** @type {LocalImportWorkerPool | null} Created once, shared, and disposed only by disposeLocalImportScan(). */
let workerPool = null;

/**
 * @returns {LocalImportWorkerPool}
 */
function ensureWorkerPool() {
    if (!workerPool) {
        workerPool = new LocalImportWorkerPool(resolveWorkerPoolSize());
    }
    return workerPool;
}

/**
 * @returns {string} This install's uploads staging directory, reused so a staged local-import file gets the same
 * lifecycle (deleted by the importFromX() functions) as a multer upload.
 */
function getUploadsDir() {
    return path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
}

/**
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

async function maybeCorrectDateAddedFromDuplicateSource(sourcePath, characterId, directories) {
    try {
        const sourceStat = await fsPromises.stat(sourcePath);
        await setCharacterDateAdded(directories, characterId, sourceStat.mtimeMs);
    } catch (err) {
        console.debug(`[local-import] Failed to update date_added for ${characterId} from source mtime ${sourcePath}:`, /** @type {any} */ (err)?.message ?? err);
    }
}

/**
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 * @param {string} filename
 * @param {number} mtimeMs
 */
async function markProcessed(state, directories, sourcePath, filename, mtimeMs, duplicateOf = null) {
    touchLastSeenMtime(state, filename, mtimeMs);
    try {
        await setLocalImportMtime(directories, sourcePath, mtimeMs, duplicateOf);
    } catch (err) {
        console.debug(`[local-import] Failed to persist processed-mtime record for ${sourcePath} (will just be re-processed on the next restart, not incorrectly):`, err.message);
    }
}


/**
 * Clears stale local_import_skips/local_import_mtimes rows once `filename` is known gone from `state.sourceDir`.
 * Shared by processFile()'s ENOENT branch (removed within this pass) and scanDirectory()'s post-readdir sweep
 * (removed between passes - readdir() never lists it, so processFile() never even runs for it).
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filename
 * @returns {Promise<void>} Never throws.
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

/** Page size for sweepRemovedFiles()'s walk of local_import_mtimes, bounding its peak memory regardless of
 * corpus size. */
const REMOVED_FILE_SWEEP_PAGE_SIZE = 5000;

/**
 * Finds and cleans up every source file `state.sourceDir`'s persisted local_import_mtimes rows know about that
 * no longer exists on disk. Checks the filesystem directly per candidate rather than diffing against a directory
 * listing: there's no bounded-memory way to hold a full listing for an unbounded directory, and no ordering
 * guarantee between a filesystem enumeration and SQLite's own collation to merge against instead.
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
async function sweepRemovedFiles(state, directories) {
    const prefix = state.sourceDir.endsWith(path.sep) ? state.sourceDir : state.sourceDir + path.sep;
    let cursor = '';
    for (;;) {
        const page = await getLocalImportMtimeSourcePathsAfter(directories, cursor, REMOVED_FILE_SWEEP_PAGE_SIZE);
        if (page.length === 0) break;
        cursor = page[page.length - 1];

        for (const sourcePath of page) {
            if (!sourcePath.startsWith(prefix)) continue;
            const filename = path.basename(sourcePath);
            const stillExists = await fsPromises.access(sourcePath, fs.constants.F_OK).then(() => true, () => false);
            if (!stillExists) {
                await cleanupRemovedFile(state, directories, filename);
            }
        }

        if (page.length < REMOVED_FILE_SWEEP_PAGE_SIZE) break; // Last page.
    }
}

/**
 * Serializes concurrent processFile() calls sharing the same content hash within one pass, so the dedup-check-
 * then-import section never runs for two same-hash files at once (there's no UNIQUE constraint on
 * characters.content_hash, and the eventual import's own re-check has the identical race window). Different
 * hashes are never blocked by each other.
 * @param {DirectoryScanState} state
 * @param {string} hash
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
function withPerHashLock(state, hash, fn) {
    if (!state.hashLocks) state.hashLocks = new Map();
    const prior = state.hashLocks.get(hash) ?? Promise.resolve();
    const run = prior.then(fn);
    // Swallow rejection only in the map's chained copy - `run` itself still carries the real outcome to this
    // call's own caller. Otherwise a rejection here would poison every future waiter for this hash.
    state.hashLocks.set(hash, run.catch(() => { }));
    return run;
}

function readTagImportSetting(directories) {
    try {
        const val = readSettingsAtPaths(directories, ['power_user.tag_import_setting'])['power_user.tag_import_setting'];
        if (val === 2) return 2;
        if (val === 4) return 4;
    } catch { /* use default */ }
    return 3;
}

/**
 * Per-filename in-flight guard around processFileImpl(): the periodic scan and the watcher (or two watcher
 * events) can land on the same filename concurrently, and withPerHashLock() alone doesn't cover that (a
 * duplicate-of-existing file short-circuits the same way regardless of the lock, so two concurrent calls would
 * each still run the full pipeline and each independently write date_added/markProcessed). A second concurrent
 * call for the same filename just joins the first call's promise instead.
 * @param {DirectoryScanState} state
 * @param {string} filename
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} [tagImportSetting]
 * @returns {Promise<void>}
 */
async function processFile(state, filename, directories, tagImportSetting = 3, bulkMtimeHints = null) {
    if (!state.inFlightFiles) state.inFlightFiles = new Map();
    const existing = state.inFlightFiles.get(filename);
    if (existing) {
        await existing.catch(() => {});
        return;
    }

    const runPromise = processFileImpl(state, filename, directories, tagImportSetting, bulkMtimeHints);
    state.inFlightFiles.set(filename, runPromise);
    try {
        await runPromise;
    } finally {
        state.inFlightFiles.delete(filename);
    }
}

/**
 * @param {DirectoryScanState} state
 * @param {string} filename
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {number} [tagImportSetting]
 * @param {Map<string, number> | null} [bulkMtimeHints] scanDirectory()'s pass-wide mtime prefetch; `null` from
 * any other caller (watcher path), which falls through to the per-file lookup instead.
 * @returns {Promise<void>}
 */
async function processFileImpl(state, filename, directories, tagImportSetting = 3, bulkMtimeHints = null) {
    const format = detectFormat(filename);
    if (!format) return;

    const sourcePath = path.join(state.sourceDir, filename);
    let stat;
    try {
        stat = await fsPromises.stat(sourcePath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            await cleanupRemovedFile(state, directories, filename);
            return;
        }
        throw err;
    }

    if (!stat.isFile()) return;

    let lastMtimeMs = state.lastSeenMtimeMs.get(filename);
    if (lastMtimeMs === undefined) {
        if (bulkMtimeHints?.has(sourcePath)) {
            lastMtimeMs = bulkMtimeHints.get(sourcePath);
            touchLastSeenMtime(state, filename, lastMtimeMs);
        } else {
            const persisted = await getLocalImportMtime(directories, sourcePath);
            if (persisted) {
                lastMtimeMs = persisted.mtimeMs;
                touchLastSeenMtime(state, filename, lastMtimeMs);
            }
        }
    }
    if (lastMtimeMs === stat.mtimeMs) {
        return;
    }

    // Gated on mtime match: a file edited since its skip was recorded falls through to reclassification instead
    // of staying permanently skipped.
    if (format === 'json') {
        const existingSkip = await getLocalImportSkip(directories, sourcePath);
        if (existingSkip && existingSkip.mtimeMs === stat.mtimeMs) {
            await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
            return;
        }
    }

    const allowIdentityFallback = getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean');

    try {
        // Hash/classify/identity-hash, and for png/json the eventual write, all run in the worker off the main
        // thread. Every sqlite call stays on this thread (no WAL/busy_timeout configured for worker access, and
        // scanDirectory() wraps the whole pass in one transaction).
        const pipelineResult = await ensureWorkerPool().runPipeline(sourcePath, format, directories, allowIdentityFallback);

        // Re-stat after the worker's read (not the pre-dispatch stat above): a file still being streamed onto
        // disk when the trigger fired can have a mid-write pre-dispatch mtime, which would otherwise get
        // persisted against the final bytes' hash and cause a spurious self-match "duplicate" next pass.
        try {
            const freshStat = await fsPromises.stat(sourcePath);
            stat.mtimeMs = freshStat.mtimeMs;
        } catch (err) {
            if (err.code === 'ENOENT') {
                await cleanupRemovedFile(state, directories, filename);
                return;
            }
            console.debug(`[local-import] Post-read re-stat failed for ${sourcePath} (falling back to the pre-dispatch mtime):`, err.message);
        }

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
            // The mtime-gated check above already means any existing skip row is stale - clear it so an
            // edited-into-importable file doesn't keep carrying a misleading skip record.
            try {
                await clearLocalImportSkip(directories, sourcePath);
            } catch (clearErr) {
                console.debug(`[local-import] Failed to clear stale local_import_skips record for ${sourcePath}:`, clearErr.message);
            }
        }

        const contentHash = pipelineResult.contentHash;

        await withPerHashLock(state, contentHash, async () => {
            const alreadyImported = await findCharacterIdByContentHash(directories, contentHash);
            if (alreadyImported) {
                if (pipelineResult.needsWrite) await pipelineResult.finish({ type: 'no-write' });
                await maybeCorrectDateAddedFromDuplicateSource(sourcePath, alreadyImported, directories);
                // duplicate_of is cascade-cleared if the matched character is later deleted, so the source file
                // falls through to a fresh dedup-check next pass instead of staying wrongly skipped.
                await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs, alreadyImported);
                return;
            }

            if (allowIdentityFallback && pipelineResult.identityHash) {
                try {
                    const identityMatch = await findCharacterIdByContentIdentityHash(directories, pipelineResult.identityHash);
                    if (identityMatch) {
                        if (pipelineResult.needsWrite) await pipelineResult.finish({ type: 'no-write' });
                        await maybeCorrectDateAddedFromDuplicateSource(sourcePath, identityMatch, directories);
                        await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs, identityMatch);
                        return;
                    }
                } catch (err) {
                    // Non-fatal: worst case here is a missed dedup, never data loss.
                    console.debug(`[local-import] Content-identity duplicate check failed for ${sourcePath} (will still attempt an ordinary import):`, err.message);
                }
            }

            if (pipelineResult.needsWrite) {
                // png/json: the worker already read/parsed the file, so build the final data here and hand it
                // back to finish the write, reusing the same buffer - no second read of sourcePath.
                let data;
                try {
                    data = format === 'png'
                        ? buildPngImportData(pipelineResult.rawText, directories)
                        : buildJsonImportData(pipelineResult.rawText, directories);
                } catch (buildErr) {
                    // Must still call finish() here or the worker's pool slot stays stuck "busy" forever.
                    await pipelineResult.finish({ type: 'no-write' }).catch(() => { });
                    throw buildErr;
                }

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
                // charx/byaf/yaml: stage+import, unchanged from before the worker pool.
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
        console.error(`[local-import] Failed to process ${sourcePath}, will retry next pass:`, err);
        // lastSeenMtimeMs deliberately not updated on failure, so a transient error gets retried, not skipped forever.
    }
}

/** Batch size for scanDirectory()'s streaming walk and its bulk mtime prefetch, bounding peak memory regardless
 * of directory size. */
const SCAN_BATCH_SIZE = 2000;

/**
 * One full pass over one configured directory: streams it in fixed-size batches, bulk-prefetching each batch's
 * persisted mtimes before dispatching through processFile(). Wrapped in beginBatchImport()/endBatchImport() so a
 * directory with many files pays one transaction/watcher-suspension window per pass, not per file.
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function scanDirectory(state, directories) {
    if (!fs.existsSync(state.sourceDir)) {
        console.warn(`[local-import] Configured directory does not exist, skipping this pass: ${state.sourceDir}`);
        return;
    }

    await beginBatchImport(directories);
    try {
        await sweepRemovedFiles(state, directories);

        let dir;
        try {
            dir = await fsPromises.opendir(state.sourceDir);
        } catch (err) {
            console.error(`[local-import] Failed to list ${state.sourceDir}, will retry next pass:`, err.message);
            return;
        }

        const tagImportSetting = readTagImportSetting(directories);
        const concurrency = resolveWorkerPoolSize();
        let batch = [];

        const runBatch = async () => {
            if (!batch.length) return;
            const sourcePaths = batch.map(filename => path.join(state.sourceDir, filename));
            const bulkMtimeHints = await getLocalImportMtimesForPaths(directories, sourcePaths);
            await mapWithConcurrency(batch, concurrency, filename => processFile(state, filename, directories, tagImportSetting, bulkMtimeHints));
            batch = [];
        };

        try {
            // Not filtered by dirent.isFile(): some filesystems don't populate directory-entry file-type info at
            // all, and opendir()'s streaming iteration has no stat-fallback for that - it would just report
            // false for everything. processFileImpl() already stats and skips non-files itself.
            for await (const dirent of dir) {
                batch.push(dirent.name);
                if (batch.length >= SCAN_BATCH_SIZE) await runBatch();
            }
            await runBatch();
        } finally {
            await dir.close().catch(() => { /* already closed by the for-await loop exhausting it - best-effort */ });
        }
    } finally {
        await endBatchImport(directories);
        state.hashLocks?.clear();
    }
}

/**
 * Per-filename dispatch shared by every watch mechanism (Linux native watch's onEvent, and fs.watch()).
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filename
 */
function handleWatchEvent(state, directories, filename) {
    // Intercept a pending heartbeat's own sentinel file before it reaches the normal import path.
    if (state.pendingHeartbeats.has(filename)) {
        const resolveHeartbeat = state.pendingHeartbeats.get(filename);
        state.pendingHeartbeats.delete(filename);
        resolveHeartbeat();
        return;
    }

    const existingTimer = state.watchTimers.get(filename);
    if (existingTimer) clearTimeout(existingTimer);
    state.watchTimers.set(filename, setTimeout(() => {
        state.watchTimers.delete(filename);
        processFile(state, filename, directories, readTagImportSetting(directories)).catch(err => {
            console.error(`[local-import] Watcher-triggered import failed for ${filename} (the periodic scan will retry it):`, err.message);
        });
    }, WATCH_DEBOUNCE_MS));
}

/**
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 */
async function startWatcherFor(state, directories) {
    if (state.watcher || state.watcherStarting || !fs.existsSync(state.sourceDir)) return;
    state.watcherStarting = true;

    try {
        if (process.platform === 'linux') {
            const handle = await attachLinuxDirectoryWatch(state.sourceDir, {
                onEvent: filename => handleWatchEvent(state, directories, filename),
                onOverflow: () => triggerImmediateRescan(),
            });
            if (handle) {
                state.watcher = handle;
                // Same handle does both jobs; this marker just keeps stopWatcherFor()'s two-resource close shape
                // from double-closing the one real inotify instance.
                state.overflowWatch = { close: () => {} };
                return;
            }
            // Native attach unavailable/failed: falls through to fs.watch(); overflowWatch stays null.
        }

        state.watcher = fs.watch(state.sourceDir, (_eventType, filename) => {
            if (isWindowsOverflowSignal(filename)) {
                triggerImmediateRescan();
                return;
            }
            if (!filename) return;
            handleWatchEvent(state, directories, filename);
        });
        state.watcher.on('error', (err) => {
            console.error(`[local-import] Directory watcher error for ${state.sourceDir} (the periodic scan remains the source of truth):`, err.message);
        });
    } catch (err) {
        console.error(`[local-import] Failed to start directory watcher for ${state.sourceDir} (the periodic scan remains the source of truth):`, err.message);
    } finally {
        state.watcherStarting = false;
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
    if (state.overflowWatch) {
        state.overflowWatch.close();
        state.overflowWatch = null;
    }
    for (const timer of state.watchTimers.values()) clearTimeout(timer);
    state.watchTimers.clear();
}

/**
 * Runs one full pass over every configured directory, then schedules the next one `scanIntervalMs` after this
 * one finishes (self-pacing, not a fixed-rate timer - a slow pass on a large corpus would otherwise overlap the
 * next tick and corrupt shared beginBatchImport()/endBatchImport() state).
 * @param {import('./users.js').UserDirectoryList} userDirectories
 * @param {number} scanIntervalMs
 * @returns {Promise<void>} Resolves once this one pass completes, not future rescheduled ones.
 */
async function runScanCycle(userDirectories, scanIntervalMs) {
    if (passInFlight) return;
    passInFlight = true;

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
    try {
        await pass;
    } finally {
        passInFlight = false;
    }

    if (disposed) return;
    scheduleNext(userDirectories, scanIntervalMs);
}

/**
 * @param {import('./users.js').UserDirectoryList} userDirectories
 * @param {number} scanIntervalMs
 */
function scheduleNext(userDirectories, scanIntervalMs) {
    if (disposed) return;

    if (allOverflowConfirmed()) {
        scanTimeout = setTimeout(() => {
            runHeartbeatCheck(userDirectories, scanIntervalMs);
        }, HEARTBEAT_INTERVAL_MS);
    } else {
        scanTimeout = setTimeout(() => {
            runScanCycle(userDirectories, scanIntervalMs);
        }, scanIntervalMs);
    }
    scanTimeout.unref?.();
}

/**
 * @param {import('./users.js').UserDirectoryList} userDirectories
 * @param {number} scanIntervalMs
 */
async function runHeartbeatCheck(userDirectories, scanIntervalMs) {
    if (disposed) return;

    const results = await Promise.all(scanStates.map(state => checkWatcherHeartbeat(state)));

    if (disposed) return;

    if (results.every(Boolean) && allOverflowConfirmed()) {
        scheduleNext(userDirectories, scanIntervalMs);
        return;
    }

    console.error('[local-import] Watcher heartbeat check missed its grace window (or overflow confirmation was lost) - falling back to a full reconcile pass to be safe.');
    runScanCycle(userDirectories, scanIntervalMs).catch(err => {
        console.error('[local-import] Heartbeat-triggered fallback scan cycle crashed unexpectedly:', err);
    });
}

/**
 * @returns {Promise<void>}
 */
export async function waitForCurrentScanPass() {
    await currentPassPromise;
}

/**
 * Runs the next pass now instead of waiting out the rest of `scanIntervalMs`. No-op if a pass is already
 * in flight or the module was never initialized.
 */
function triggerImmediateRescan() {
    if (passInFlight || !capturedUserDirectories || capturedScanIntervalMs === null) return;
    if (scanTimeout) {
        clearTimeout(scanTimeout);
        scanTimeout = null;
    }
    runScanCycle(capturedUserDirectories, capturedScanIntervalMs).catch(err => {
        console.error('[local-import] Overflow-triggered scan cycle crashed unexpectedly:', err);
    });
}

/**
 * Server-boot entry point. Reads `localImport.directories`/`enabled`/`scanIntervalMs`/`watchEnabled` from
 * config.yaml and starts the scan cycle. Deliberately not awaited by the caller - a full pass over a large
 * corpus must never block the server from listening; tests use waitForCurrentScanPass() instead.
 * @returns {Promise<void>}
 */
export async function initializeLocalImportScan() {
    disposeLocalImportScan(); // Idempotent re-init.
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
        pendingHeartbeats: new Map(),
    }));

    for (const state of scanStates) {
        if (watchEnabled) {
            startWatcherFor(state, userDirectories).catch(err => {
                console.error(`[local-import] Unexpected error starting the watcher for ${state.sourceDir}:`, err.message);
            });
        }
    }

    ensureWorkerPool();

    runScanCycle(userDirectories, scanIntervalMs).catch(err => {
        console.error('[local-import] Scan cycle crashed unexpectedly:', err);
    });
}

/**
 * Graceful-shutdown / test-teardown counterpart to initializeLocalImportScan(): closes every watcher, stops any
 * in-flight scan cycle from rescheduling, and tears down the worker pool.
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
    // Reset unconditionally: a pass stuck (e.g. hung filesystem) past worker-pool teardown could otherwise leave
    // passInFlight permanently true and deadlock every future pass, including the next init's own first one.
    passInFlight = false;
    if (scanTimeout) {
        clearTimeout(scanTimeout);
        scanTimeout = null;
    }
    if (workerPool) {
        const poolToDispose = workerPool;
        workerPool = null;
        poolToDispose.dispose().catch(err => {
            console.error('[local-import] Worker pool disposal failed:', err);
        });
    }
}
