import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import bytes from 'bytes';

import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { getStringHash } from '../../public/scripts/hash-utils.js';
import {
    readAllSettingsAsJson,
    readSettingsAtPaths,
    writeSettingsKeys,
    writeAllSettings,
    settingsExist,
} from '../settings-store.js';

const ENABLE_EXTENSIONS = !!getConfigValue('extensions.enabled', true, 'boolean');
const ENABLE_EXTENSIONS_AUTO_UPDATE = !!getConfigValue('extensions.autoUpdate', true, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const ENABLE_REQUEST_COMPRESSION = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');
const REQUEST_COMPRESSION_MIN = bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb'));
const REQUEST_COMPRESSION_MAX = bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb'));
const REQUEST_COMPRESSION_TIMEOUT = Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number'));

// 10 minutes
const AUTOSAVE_INTERVAL = 10 * 60 * 1000;

/**
 * Map of functions to trigger settings autosave for a user.
 * @type {Map<string, function>}
 */
const AUTOSAVE_FUNCTIONS = new Map();

/**
 * Triggers autosave for a user every 10 minutes.
 * @param {string} handle User handle
 * @returns {void}
 */
function triggerAutoSave(handle) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(() => backupUserSettings(handle, true).catch(err => console.error('Autosave failed', err)), AUTOSAVE_INTERVAL);
        AUTOSAVE_FUNCTIONS.set(handle, throttledAutoSave);
    }

    const functionToCall = AUTOSAVE_FUNCTIONS.get(handle);
    if (functionToCall && typeof functionToCall === 'function') {
        functionToCall();
    }
}

/**
 * Reads and parses files from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {string} fileExtension File extension
 * @returns {Array} Parsed files
 */
function readAndParseFromDirectory(directoryPath, fileExtension = '.json') {
    const files = fs
        .readdirSync(directoryPath)
        .filter(x => path.parse(x).ext == fileExtension)
        .sort();

    const parsedFiles = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf-8');
            parsedFiles.push(fileExtension == '.json' ? JSON.parse(file) : file);
        } catch {
            // skip
        }
    });

    return parsedFiles;
}

/**
 * Gets a sort function for sorting strings.
 * @param {*} _
 * @returns {(a: string, b: string) => number} Sort function
 */
function sortByName(_) {
    return (a, b) => a.localeCompare(b);
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
}

function readPresetsFromDirectory(directoryPath, options = {}) {
    const {
        sortFunction,
        removeFileExtension = false,
        fileExtension = '.json',
    } = options;

    const files = fs.readdirSync(directoryPath).sort(sortFunction).filter(x => path.parse(x).ext == fileExtension);
    const fileContents = [];
    const fileNames = [];

    files.forEach(item => {
        try {
            const file = fs.readFileSync(path.join(directoryPath, item), 'utf8');
            JSON.parse(file);
            fileContents.push(file);
            fileNames.push(removeFileExtension ? item.replace(/\.[^/.]+$/, '') : item);
        } catch {
            // skip
            console.warn(`${item} is not a valid JSON`);
        }
    });

    return { fileContents, fileNames };
}

async function backupSettings() {
    try {
        const userHandles = await getAllUserHandles();

        for (const handle of userHandles) {
            await backupUserSettings(handle, true);
        }
    } catch (err) {
        console.error('Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings - the same flat object /api/settings/get reconstructs from the sharded
 * settings/ store, serialized the same canonical way, snapshotted as one JSON file. Same restore-compatible
 * shape a plain copy of a monolithic settings.json used to be; the sharded on-disk layout underneath is not
 * something a backup/restore snapshot needs to know about.
 *
 * Used to also merge in a full tag definitions/tag_map export reconstructed from the metadata sqlite store
 * (a now-deleted mergeTagsIntoSnapshot() in tags.js -> getFullTagMapExport() -> a full scan of every
 * character_tags row) so the backup would carry tag_map the way the old tags.json-era backups did. That's gone,
 * on both the write side here and the restore side (restore-snapshot below, which used to import tags/tag_map
 * back out of a restored snapshot via a now-deleted splitTagsFromSnapshot()): character_tags/group_tags in the
 * metadata store already ARE the durable, backed-up-with-the-database record of tag assignments, and settings
 * were never authoritative for them even in the tags.json-era shape this was preserving - there's no reader
 * anywhere that needs the settings path to know about tags in either direction. See getFullTagMapExport()'s own
 * doc comment on where that capability still lives if something genuinely needs a full export/import of tag
 * assignments later.
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {Promise<void>}
 */
async function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!fs.existsSync(userDirectories.root)) {
        return;
    }

    if (!settingsExist(userDirectories)) {
        return;
    }

    let snapshotContent;
    try {
        snapshotContent = readAllSettingsAsJson(userDirectories);
    } catch (err) {
        console.error('Could not read settings for backup', err);
        return;
    }

    if (preventDuplicates && isDuplicateBackup(handle, snapshotContent)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    writeFileAtomicSync(backupFile, snapshotContent, 'utf8');
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks if the backup would be a duplicate of the latest existing one.
 * @param {string} handle User handle
 * @param {string} content The snapshot content that would be written
 * @returns {boolean} True if the backup is a duplicate
 */
function isDuplicateBackup(handle, content) {
    const latestBackup = getLatestBackup(handle);
    if (!latestBackup || !fs.existsSync(latestBackup)) {
        return false;
    }
    return fs.readFileSync(latestBackup, 'utf8') === content;
}

/**
 * Gets the latest backup file for a user.
 * @param {string} handle User handle
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle) {
    const userDirectories = getUserDirectories(handle);
    const backupFiles = fs.readdirSync(userDirectories.backups)
        .filter(x => x.startsWith(getSettingsBackupFilePrefix(handle)))
        .map(x => ({ name: x, ctime: fs.statSync(path.join(userDirectories.backups, x)).ctimeMs }));
    const latestBackup = backupFiles.sort((a, b) => b.ctime - a.ctime)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

export const router = express.Router();

/**
 * Optimistic-concurrency guard for concurrent /save calls from multiple tabs/devices. The client sends the hash
 * of the settings content it currently believes is on disk (X-Settings-Hash, from the last /get or successful
 * /save it saw - see saveSettings()/getSettings() in script.js); this hashes the *actual* current on-disk
 * content the same way (cyrb53 via getStringHash, shared with the client instead of reimplemented, so both
 * sides always agree) and compares. A mismatch means some other session wrote in between, so the caller's view
 * is stale and its write must not proceed - otherwise it would silently clobber that other write with whatever
 * this caller had, which is the actual bug this exists to close.
 *
 * Re-reads the sharded settings store fresh on every call rather than keeping a separately persisted "last known
 * hash": a cached hash could itself drift from disk (external edits, a restore-snapshot, a crash mid-write) in
 * ways a persisted value wouldn't self-correct from - reading the actual current content is the only value
 * that's always trustworthy. The canonical serialization (readAllSettingsAsJson) is the same one /api/settings/
 * get sends and /save-partial's returned settingsHash is computed from, so a hash obtained from any of those
 * three places is comparable against any of the others - a user with no settings at all yet hashes as the
 * canonical empty object, `"{}"`, not an empty string.
 *
 * The header is optional and its absence skips the check entirely (today's unconditional-overwrite behavior) -
 * this keeps the endpoint backward compatible with any caller that doesn't send it, rather than hard-requiring
 * every caller to opt in before it can save at all.
 * @param {import('express').Request} request Express request
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {{ ok: true } | { ok: false }} Whether the save may proceed
 */
function checkSettingsConflict(request, directories) {
    const expectedHashHeader = request.get('X-Settings-Hash');
    if (expectedHashHeader === undefined) {
        return { ok: true };
    }

    const expectedHash = Number(expectedHashHeader);
    if (!Number.isFinite(expectedHash)) {
        // Malformed header shouldn't cost the caller their save - treat it the same as absent.
        return { ok: true };
    }

    const currentHash = getStringHash(readAllSettingsAsJson(directories));
    return { ok: currentHash === expectedHash };
}

router.post('/save', function (request, response) {
    try {
        const directories = request.user.directories;

        const conflictCheck = checkSettingsConflict(request, directories);
        if (!conflictCheck.ok) {
            return response.status(409).send({
                result: 'conflict',
                error: 'Settings were changed by another session since this client last loaded or saved them.',
            });
        }

        // Full replace: writes one file per top-level key in the body, same "whatever this body doesn't have,
        // the store no longer has either" semantics a whole-file overwrite of settings.json used to have.
        writeAllSettings(directories, request.body);
        triggerAutoSave(request.user.profile.handle);
        // The client can no longer just hash its own JSON.stringify(payload) locally to know what the server
        // now has: readAllSettingsAsJson() reconstructs top-level keys in filename (alphabetical) order, which
        // won't generally match the client's own object's insertion order even though the content is identical.
        // Returning the server's own canonical hash (same function checkSettingsConflict() above hashes
        // against) is what saveSettings() now stores as knownServerSettingsHash - see its client-side doc
        // comment.
        response.send({ result: 'ok', settingsHash: getStringHash(readAllSettingsAsJson(directories)) });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

/**
 * Partial-update alternative to /save: writes only the given top-level (or dotted-path) keys, via
 * settings-store.js's writeSettingsKeys() - the on-disk file(s) for any OTHER key are never even opened, let
 * alone rewritten. New, additive capability - /save is unchanged and stays the path virtually every caller
 * uses; nothing is required to migrate. Legal because settings' top-level shape is already a flat dict of
 * independent subsystems (power_user, extension_settings, world_info_settings, ...) with /save as its only
 * full-replace writer - "merge only the keys present in the request" has a clean, unambiguous meaning at that
 * level. This is also the actual fix for the disk-write side of things: an earlier version of this endpoint
 * already accepted a request naming just the touched key(s) but still read, re-serialized, and rewrote the
 * ENTIRE settings store on every call (a network-payload optimization only, not a disk-I/O one) - see
 * settings-store.js's own module header for why sharding into one file per key was the only way to close that
 * gap for a plain JSON store.
 *
 * Conflict check is per-key (via readSettingsAtPaths, which itself only reads the top-level key file(s) the
 * requested paths belong to), not the whole-file X-Settings-Hash /save uses - a whole-file hash would reject
 * this call on *any* concurrent change anywhere, even to a completely unrelated key, which would defeat a chunk
 * of the point of a partial-update mechanism given the flat-independent-subsystems shape above. Per-key hashing
 * lets two concurrent partial updates to genuinely disjoint keys both succeed; only a real overlap gets
 * rejected. expectedHashes is optional, same backward-compat stance as X-Settings-Hash: omit it and the merge
 * proceeds unconditionally.
 *
 * Concurrency safety for the read-modify-write itself: this handler is synchronous start to finish (the
 * settings-store reads/writes below, no `await` anywhere in between), so nothing else can run on this process's
 * event loop between the read and the write - Node never starts a second request's handler body until the
 * first one's synchronous code has fully returned, so two concurrent /save-partial calls can't interleave their
 * read-modify-write halves. The hash check only protects against a *stale* client; this synchronous-handler
 * property is what protects two fresh, hash-valid requests from racing each other on the read (whichever one's
 * handler runs first will have already changed the on-disk hash by the time the second one's per-key check
 * runs, so a genuine overlap still gets caught even under a race). This guarantee is specific to a single Node
 * process - if this server ever runs clustered across multiple worker processes, it would need real
 * cross-process file locking instead.
 */
router.post('/save-partial', function (request, response) {
    try {
        const directories = request.user.directories;

        const { keys, expectedHashes } = request.body ?? {};
        if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
            return response.status(400).send({
                result: 'error',
                error: 'Partial update body must include a "keys" object of top-level settings keys to merge.',
            });
        }

        if (expectedHashes && typeof expectedHashes === 'object' && !Array.isArray(expectedHashes)) {
            const paths = Object.keys(expectedHashes);
            const currentValues = readSettingsAtPaths(directories, paths);
            const conflictingKeys = paths.filter(path => getStringHash(JSON.stringify(currentValues[path], null, 4)) !== expectedHashes[path]);
            if (conflictingKeys.length > 0) {
                return response.status(409).send({
                    result: 'conflict',
                    error: 'Some of the settings keys in this update were changed by another session since this client last saw them.',
                    conflictingKeys,
                });
            }
        }

        try {
            writeSettingsKeys(directories, keys);
        } catch (err) {
            console.error('Could not write partial settings update', err);
            return response.status(400).send({ result: 'error', error: err.message });
        }

        triggerAutoSave(request.user.profile.handle);
        // Same reasoning as /save's response above: return the server's own canonical whole-store hash so the
        // client's knownServerSettingsHash stays correct without needing to know how the store reconstructs it.
        response.send({ result: 'ok', settingsHash: getStringHash(readAllSettingsAsJson(directories)) });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

// Wintermute's code
router.post('/get', (request, response) => {
    let settings;
    try {
        settings = readAllSettingsAsJson(request.user.directories);
    } catch (e) {
        return response.sendStatus(500);
    }

    // NovelAI Settings
    const { fileContents: novelai_settings, fileNames: novelai_setting_names }
        = readPresetsFromDirectory(request.user.directories.novelAI_Settings, {
            sortFunction: sortByName(request.user.directories.novelAI_Settings),
            removeFileExtension: true,
        });

    // OpenAI Settings
    const { fileContents: openai_settings, fileNames: openai_setting_names }
        = readPresetsFromDirectory(request.user.directories.openAI_Settings, {
            sortFunction: sortByName(request.user.directories.openAI_Settings), removeFileExtension: true,
        });

    // TextGenerationWebUI Settings
    const { fileContents: textgenerationwebui_presets, fileNames: textgenerationwebui_preset_names }
        = readPresetsFromDirectory(request.user.directories.textGen_Settings, {
            sortFunction: sortByName(request.user.directories.textGen_Settings), removeFileExtension: true,
        });

    //Kobold
    const { fileContents: koboldai_settings, fileNames: koboldai_setting_names }
        = readPresetsFromDirectory(request.user.directories.koboldAI_Settings, {
            sortFunction: sortByName(request.user.directories.koboldAI_Settings), removeFileExtension: true,
        });

    const worldFiles = fs
        .readdirSync(request.user.directories.worlds)
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));
    const world_names = worldFiles.map(item => path.parse(item).name);

    const themes = readAndParseFromDirectory(request.user.directories.themes);
    const movingUIPresets = readAndParseFromDirectory(request.user.directories.movingUI);
    const quickReplyPresets = readAndParseFromDirectory(request.user.directories.quickreplies);

    const instruct = readAndParseFromDirectory(request.user.directories.instruct);
    const context = readAndParseFromDirectory(request.user.directories.context);
    const sysprompt = readAndParseFromDirectory(request.user.directories.sysprompt);
    const reasoning = readAndParseFromDirectory(request.user.directories.reasoning);

    response.send({
        settings,
        koboldai_settings,
        koboldai_setting_names,
        world_names,
        novelai_settings,
        novelai_setting_names,
        openai_settings,
        openai_setting_names,
        textgenerationwebui_presets,
        textgenerationwebui_preset_names,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
        enable_extensions: ENABLE_EXTENSIONS,
        enable_extensions_auto_update: ENABLE_EXTENSIONS_AUTO_UPDATE,
        enable_accounts: ENABLE_ACCOUNTS,
        request_compression: {
            enabled: ENABLE_REQUEST_COMPRESSION,
            minPayloadSize: REQUEST_COMPRESSION_MIN || 0,
            maxPayloadSize: REQUEST_COMPRESSION_MAX || 0,
            timeout: REQUEST_COMPRESSION_TIMEOUT || 0,
        },
    });
});

router.post('/get-snapshots', async (request, response) => {
    try {
        const snapshots = fs.readdirSync(request.user.directories.backups);
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);
        const userSnapshots = snapshots.filter(x => x.startsWith(userFilesPattern));

        const result = userSnapshots.map(x => {
            const stat = fs.statSync(path.join(request.user.directories.backups, x));
            return { date: stat.ctimeMs, name: x, size: stat.size };
        });

        response.json(result);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/load-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const content = fs.readFileSync(snapshotPath, 'utf8');

        response.send(content);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/make-snapshot', async (request, response) => {
    try {
        await backupUserSettings(request.user.profile.handle, false);
        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/restore-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!fs.existsSync(snapshotPath)) {
            return response.sendStatus(404);
        }

        const snapshotContent = fs.readFileSync(snapshotPath, 'utf8');
        const snapshotSettings = JSON.parse(snapshotContent); // Validate it's actually valid JSON, and get the object writeAllSettings() needs.

        // The settings path doesn't know about tags in either direction (see backupUserSettings()'s own doc
        // comment) - a restore is a full replace of the sharded store from the snapshot's keys, same as a
        // backup is a plain reconstruction the other way. An old snapshot that happens to still carry
        // `tags`/`tag_map` (made before that change, or a pre-phase-3 tags.json-era one) restores those fields
        // back unmodified rather than importing them into the metadata store - inert leftover data, not live
        // state - since tag definitions/assignments there were never authoritative even when a backup carried
        // them, and this route no longer special-cases that shape.
        writeAllSettings(request.user.directories, snapshotSettings);

        response.sendStatus(204);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

/**
 * Initializes the settings endpoint
 */
export async function init() {
    await backupSettings();
}
