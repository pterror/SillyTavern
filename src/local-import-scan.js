import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

import { getConfigValue, color, mapWithConcurrency } from './util.js';
import { ProgressLog } from './progress-log.js';
import { DEFAULT_USER, UPLOADS_DIRECTORY } from './constants.js';
import { getUserDirectories } from './users.js';
import { readUserSettings } from './settings-reads.js';
import { copyCharacterFile } from './local-import-copy.js';
import { importCharacterFileHeadless, buildPngImportData, buildJsonImportData, mintCharacterId } from './endpoints/characters.js';
import { userStore } from './user-stores.js';
import { HASH, TYPE } from './library-engine.js';
import { linkWithAvatar, writeWithAvatar } from './character-avatars.js';
import { attachLinuxDirectoryWatch, isWindowsOverflowSignal } from './watch-overflow.js';
import { detectFormat } from './local-import-classify.js';
import { LocalImportWorkerPool, resolveWorkerPoolSize } from './local-import-worker-pool.js';
import { importFailure } from './character-import-error.js';


const WATCH_DEBOUNCE_MS = 300;

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
 * @property {Map<string, number>} lastSeenMtimeMs
 * @property {fs.FSWatcher | { close: () => void } | null} watcher
 * @property {boolean} [watcherStarting]
 * @property {Map<string, NodeJS.Timeout>} watchTimers
 * @property {{ close: () => void } | null} overflowWatch
 * @property {Map<string, () => void>} pendingHeartbeats
 * @property {Map<string, Promise<void>>} [hashLocks]
 * @property {Map<string, Promise<void>>} [inFlightFiles]
 * @property {ProgressLog | null} [scanProgress]
 */

/**
 * @returns {boolean}
 */
function allOverflowConfirmed() {
    return scanStates.length > 0 && scanStates.every(state => state.overflowWatch !== null);
}

const HEARTBEAT_INTERVAL_MS = getConfigValue('localImport.watcherHeartbeatIntervalMs', 60 * 1000, 'number');

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
/** @type {import('./users.js').UserDirectoryList | null} */
let capturedUserDirectories = null;
/** @type {number | null} */
let capturedScanIntervalMs = null;
let disposed = false;
let passInFlight = false;
/** @type {Promise<void> | null} */
let currentPassPromise = null;
/** @type {LocalImportWorkerPool | null} */
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
 * @returns {string}
 */
function getUploadsDir() {
    return path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);
}

/**
 * @param {string} sourcePath
 * @returns {Promise<string>}
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
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} sourcePath
 * @param {string} filename
 * @param {number} mtimeMs
 */
async function markProcessed(state, directories, sourcePath, filename, mtimeMs, duplicateOf = null) {
    touchLastSeenMtime(state, filename, mtimeMs);
    try {
        await (await userStore(directories)).lib.setLocalImportMtime(sourcePath, mtimeMs, duplicateOf);
    } catch (err) {
        console.debug(`[local-import] Failed to persist processed-mtime record for ${sourcePath} (will just be re-processed on the next restart, not incorrectly):`, err.message);
    }
}


/**
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filename
 * @returns {Promise<void>}
 */
async function cleanupRemovedFile(state, directories, filename) {
    state.lastSeenMtimeMs.delete(filename);
    const sourcePath = path.join(state.sourceDir, filename);
    try {
        await (await userStore(directories)).lib.clearLocalImportMtime(sourcePath);
    } catch (clearErr) {
        console.debug(`[local-import] Failed to clear stale local_import_mtimes record for ${sourcePath}:`, clearErr.message);
    }
    try {
        await (await userStore(directories)).lib.clearLocalImportSkip(sourcePath);
    } catch (clearErr) {
        console.debug(`[local-import] Failed to clear stale local_import_skips record for ${sourcePath}:`, clearErr.message);
    }
}

const REMOVED_FILE_SWEEP_PAGE_SIZE = 5000;

/**
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
async function sweepRemovedFiles(state, directories) {
    const prefix = state.sourceDir.endsWith(path.sep) ? state.sourceDir : state.sourceDir + path.sep;
    let cursor = '';
    for (;;) {
        const page = await (await userStore(directories)).lib.localImportPathsAfter(cursor, REMOVED_FILE_SWEEP_PAGE_SIZE);
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

        if (page.length < REMOVED_FILE_SWEEP_PAGE_SIZE) break;
    }
}

/**
 * @param {DirectoryScanState} state
 * @param {string} hash
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
function withPerHashLock(state, hash, fn) {
    if (!state.hashLocks) state.hashLocks = new Map();
    const prior = state.hashLocks.get(hash) ?? Promise.resolve();
    const run = prior.then(fn);
    state.hashLocks.set(hash, run.catch(() => { }));
    return run;
}

function readTagImportSetting(directories) {
    try {
        const val = readUserSettings(directories, ['power_user.tag_import_setting'])['power_user.tag_import_setting'];
        if (val === 2) return 2;
        if (val === 4) return 4;
    } catch { /* use default */ }
    return 3;
}

/**
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
 * @param {Map<string, number> | null} [bulkMtimeHints]
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
            const persisted = (await (await userStore(directories)).lib.localImportMtimes([sourcePath])).get(sourcePath);
            if (persisted !== undefined) {
                lastMtimeMs = persisted;
                touchLastSeenMtime(state, filename, lastMtimeMs);
            }
        }
    }
    if (lastMtimeMs === stat.mtimeMs) {
        return;
    }

    if (format === 'json') {
        const existingSkip = await (await userStore(directories)).lib.localImportSkip(sourcePath);
        if (existingSkip && existingSkip.mtimeMs === stat.mtimeMs) {
            await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
            return;
        }
    }

    const allowIdentityFallback = getConfigValue('performance.allowExpensiveDuplicateFallback', true, 'boolean');

    try {
        const pipelineResult = await ensureWorkerPool().runPipeline(sourcePath, format, directories, allowIdentityFallback);

        try {
            const freshStat = await fsPromises.stat(sourcePath);
            stat.mtimeMs = freshStat.mtimeMs;
            stat.size = freshStat.size;
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
            await (await userStore(directories)).lib.setLocalImportSkip(sourcePath, stat.mtimeMs, classification);
            await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs);
            return;
        }

        if (format === 'json') {
            try {
                await (await userStore(directories)).lib.clearLocalImportSkip(sourcePath);
            } catch (clearErr) {
                console.debug(`[local-import] Failed to clear stale local_import_skips record for ${sourcePath}:`, clearErr.message);
            }
        }

        const contentHash = pipelineResult.contentHash;

        await withPerHashLock(state, contentHash, async () => {
            const { lib } = await userStore(directories);
            const alreadyImported = await lib.findByHash(HASH.content, contentHash);
            if (alreadyImported) {
                if (pipelineResult.needsWrite) await pipelineResult.finish({ type: 'no-write' });
                await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs, alreadyImported);
                return;
            }

            if (allowIdentityFallback && pipelineResult.identityHash) {
                try {
                    const identityMatch = await lib.findByHash(HASH.identity, pipelineResult.identityHash);
                    if (identityMatch) {
                        if (pipelineResult.needsWrite) await pipelineResult.finish({ type: 'no-write' });
                        await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs, identityMatch);
                        return;
                    }
                } catch (err) {
                    console.debug(`[local-import] Content-identity duplicate check failed for ${sourcePath} (will still attempt an ordinary import):`, err.message);
                }
            }

            let importedCharacterId = null;

            if (pipelineResult.needsWrite) {
                let pngName;
                try {
                    pngName = await mintCharacterId(directories);
                } catch (mintErr) {
                    await pipelineResult.finish({ type: 'no-write' }).catch(() => { });
                    throw mintErr;
                }

                let data;
                try {
                    data = format === 'png'
                        ? buildPngImportData(pipelineResult.rawText, directories, pngName)
                        : buildJsonImportData(pipelineResult.rawText, directories, pngName);
                } catch (buildErr) {
                    await pipelineResult.finish({ type: 'no-write' }).catch(() => { });
                    throw buildErr;
                }

                if (data === null) {
                    await pipelineResult.finish({ type: 'no-write' });
                    console.warn(`[local-import] Failed to import ${sourcePath} (unrecognized content or import error) - will retry next pass.`);
                } else {
                    const writeCard = (/** @type {string} */ avatarIdentityHash) => () => lib.writeCard(directories, `${pngName}.png`, data, {
                        contentHash, avatarIdentityHash, dateAdded: Math.round(stat.mtimeMs),
                    });
                    let stored = true;
                    if (format === 'png') {
                        await pipelineResult.finish({ type: 'no-write' });
                        if (!pipelineResult.avatarIdentityHash) throw new Error('the import worker answered no image hash');
                        stored = await linkWithAvatar(lib, directories, `${pngName}.png`, sourcePath, async () => {
                            await writeCard(pipelineResult.avatarIdentityHash)();
                            return true;
                        }, { size: stat.size, mtimeMs: stat.mtimeMs }) ?? false;
                    } else {
                        const { image } = await pipelineResult.finish({ type: 'write' });
                        if (!image) throw new Error('the import worker answered no image');
                        await writeWithAvatar(lib, directories, `${pngName}.png`, image, writeCard(image.avatarIdentityHash));
                    }
                    if (!stored) {
                        console.debug(`[local-import] ${sourcePath} changed while it was imported; it is imported as it is now when next seen.`);
                        return;
                    }
                    importedCharacterId = `${pngName}.png`;
                    state.scanProgress?.add();
                    if (tagImportSetting !== 2) {
                        try {
                            await lib.tags.seedCardTags(`${pngName}.png`);
                        } catch (err) {
                            console.warn(`[local-import] Failed to seed tags for ${pngName}.png:`, err.message);
                        }
                    }
                }
            } else {
                const stagedPath = await stageFile(sourcePath);
                const result = await importCharacterFileHeadless(stagedPath, format, directories, {
                    userHandle: DEFAULT_USER.handle,
                    contentHash,
                });

                if (!result) {
                    console.warn(`[local-import] Failed to import ${sourcePath} (unrecognized content or import error) - will retry next pass.`);
                } else if ('duplicateOf' in result) {
                    importedCharacterId = result.duplicateOf;
                    console.debug(`[local-import] Skipped ${sourcePath} - duplicate of already-imported character ${result.duplicateOf}.`);
                } else {
                    importedCharacterId = `${result.fileName}.png`;
                    state.scanProgress?.add();
                    try {
                        await lib.updateEntity(TYPE.character, `${result.fileName}.png`, { dateAdded: Math.round(stat.mtimeMs) });
                    } catch (err) {
                        console.debug(`[local-import] Failed to set date_added for ${result.fileName}.png from source mtime ${sourcePath}:`, err.message);
                    }
                    if (tagImportSetting !== 2) {
                        try {
                            await lib.tags.seedCardTags(`${result.fileName}.png`);
                        } catch (err) {
                            console.warn(`[local-import] Failed to seed tags for ${result.fileName}.png:`, err.message);
                        }
                    }
                }
            }

            await markProcessed(state, directories, sourcePath, filename, stat.mtimeMs, importedCharacterId);
        });
    } catch (err) {
        console.error('[local-import] Will retry next pass:', importFailure(sourcePath, err));
    }
}

const SCAN_BATCH_SIZE = 2000;

/**
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<void>}
 */
export async function scanDirectory(state, directories) {
    if (!fs.existsSync(state.sourceDir)) {
        console.warn(`[local-import] Configured directory does not exist, skipping this pass: ${state.sourceDir}`);
        return;
    }

    state.scanProgress = new ProgressLog({ what: `[local-import] importing new cards from ${state.sourceDir}` });
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
            const bulkMtimeHints = await (await userStore(directories)).lib.localImportMtimes(sourcePaths);
            await mapWithConcurrency(batch, concurrency, filename => processFile(state, filename, directories, tagImportSetting, bulkMtimeHints));
            batch = [];
        };

        try {
            for await (const dirent of dir) {
                batch.push(dirent.name);
                if (batch.length >= SCAN_BATCH_SIZE) await runBatch();
            }
            await runBatch();
        } finally {
            await dir.close().catch(() => { /* already closed by the for-await loop exhausting it - best-effort */ });
        }
    } finally {
        state.hashLocks?.clear();
        const { scanProgress } = state;
        state.scanProgress = null;
        if (scanProgress && scanProgress.done > 1) {
            scanProgress.finish();
        }
    }
}

/**
 * @param {DirectoryScanState} state
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} filename
 */
function handleWatchEvent(state, directories, filename) {
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
                state.overflowWatch = { close: () => {} };
                return;
            }
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
 * @param {import('./users.js').UserDirectoryList} userDirectories
 * @param {number} scanIntervalMs
 * @returns {Promise<void>}
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
 * @returns {Promise<void>}
 */
export async function initializeLocalImportScan() {
    disposeLocalImportScan();
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

export function disposeLocalImportScan() {
    disposed = true;
    for (const state of scanStates) {
        stopWatcherFor(state);
    }
    scanStates = [];
    currentPassPromise = null;
    capturedUserDirectories = null;
    capturedScanIntervalMs = null;
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
