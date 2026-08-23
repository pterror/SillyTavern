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
import { beginBatchImport, endBatchImport, findCharacterIdByContentHash, findCharacterIdByContentIdentityHash, computeContentIdentityHash } from './character-metadata-db.js';
import { read as readCharacterCard } from './character-card-parser.js';
import { getCharaCardV2, convertToV2 } from './character-card-normalize.js';

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
        const contentHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');

        // Cheap pre-copy dedup check: skip staging entirely for a file already in the library. Correctness of
        // dedup does not depend on this - importCharacterFileHeadless() re-checks the same hash right before
        // actually importing - this only saves the reflink/hardlink/copy work for the common "rescanning a
        // directory whose files are already all imported" case.
        const alreadyImported = await findCharacterIdByContentHash(directories, contentHash);
        if (alreadyImported) {
            await maybeHardlinkDuplicateSource(sourcePath, alreadyImported, contentHash, directories);
            state.lastSeenMtimeMs.set(filename, stat.mtimeMs);
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
                    state.lastSeenMtimeMs.set(filename, stat.mtimeMs);
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

        state.lastSeenMtimeMs.set(filename, stat.mtimeMs);
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
