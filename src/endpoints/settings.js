import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import bytes from 'bytes';

import { SETTINGS_FILE } from '../constants.js';
import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { mergeTagsIntoSnapshot, splitTagsFromSnapshot } from './tags.js';
import { getStringHash, hashSettingsKeys } from '../../public/scripts/hash-utils.js';

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
 * Makes a backup of the user's settings file. The backup is a single file that fully captures state: tag
 * definitions and tag_map get merged in from the per-user metadata sqlite store at backup time (see
 * mergeTagsIntoSnapshot in tags.js) even though settings.json itself doesn't carry those fields - tags.json
 * itself is gone entirely (phase 3, owner decision).
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {Promise<void>}
 */
async function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!fs.existsSync(userDirectories.root)) {
        return;
    }

    const sourceFile = path.join(userDirectories.root, SETTINGS_FILE);

    if (!fs.existsSync(sourceFile)) {
        return;
    }

    let snapshotContent;
    try {
        const settingsContent = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
        snapshotContent = JSON.stringify(await mergeTagsIntoSnapshot(handle, userDirectories, settingsContent), null, 4);
    } catch (err) {
        console.error('Could not read/parse settings file for backup', err);
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
 * @param {string} content The (already tags-merged) snapshot content that would be written
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
 * Hashes the file fresh on every call rather than keeping a separately persisted "last known hash": at this
 * file's size (tens to a couple hundred KB) that's cheap, and a cached hash could itself drift from disk
 * (external edits, a restore-snapshot, a crash mid-write) in ways a persisted value wouldn't self-correct from -
 * reading the actual current bytes is the only value that's always trustworthy.
 *
 * The header is optional and its absence skips the check entirely (today's unconditional-overwrite behavior) -
 * this keeps the endpoint backward compatible with any caller that doesn't send it, rather than hard-requiring
 * every caller to opt in before it can save at all.
 * @param {import('express').Request} request Express request
 * @param {string} pathToSettings Absolute path to the user's settings.json
 * @returns {{ ok: true } | { ok: false }} Whether the save may proceed
 */
function checkSettingsConflict(request, pathToSettings) {
    const expectedHashHeader = request.get('X-Settings-Hash');
    if (expectedHashHeader === undefined) {
        return { ok: true };
    }

    const expectedHash = Number(expectedHashHeader);
    if (!Number.isFinite(expectedHash)) {
        // Malformed header shouldn't cost the caller their save - treat it the same as absent.
        return { ok: true };
    }

    const currentContent = fs.existsSync(pathToSettings) ? fs.readFileSync(pathToSettings, 'utf8') : '';
    const currentHash = getStringHash(currentContent);
    return { ok: currentHash === expectedHash };
}

router.post('/save', function (request, response) {
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);

        const conflictCheck = checkSettingsConflict(request, pathToSettings);
        if (!conflictCheck.ok) {
            return response.status(409).send({
                result: 'conflict',
                error: 'Settings were changed by another session since this client last loaded or saved them.',
            });
        }

        writeFileAtomicSync(pathToSettings, JSON.stringify(request.body, null, 4), 'utf8');
        triggerAutoSave(request.user.profile.handle);
        response.send({ result: 'ok' });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

/**
 * Partial-update alternative to /save: merges only the given top-level keys into the existing settings.json
 * (read-modify-write) instead of requiring the full ~148KB blob every time. New, additive capability - /save is
 * unchanged and stays the path virtually every caller uses; nothing is required to migrate. Legal because
 * settings.json's top-level shape is already a flat dict of independent subsystems (power_user,
 * extension_settings, world_info_settings, ...) with /save as its only writer - "merge only the keys present in
 * the request" has a clean, unambiguous meaning at that level.
 *
 * Conflict check is per-key (see hashSettingsKeys), not the whole-file X-Settings-Hash /save uses - a
 * whole-file hash would reject this call on *any* concurrent change anywhere, even to a completely unrelated
 * key, which would defeat a chunk of the point of a partial-update mechanism given the flat-independent-
 * subsystems shape above. Per-key hashing lets two concurrent partial updates to genuinely disjoint keys both
 * succeed; only a real overlap gets rejected. expectedHashes is optional, same backward-compat stance as
 * X-Settings-Hash: omit it and the merge proceeds unconditionally.
 *
 * Concurrency safety for the read-modify-write itself: this handler is synchronous start to finish
 * (readFileSync below, writeFileAtomicSync at the end, no `await` anywhere in between), so nothing else can run
 * on this process's event loop between the read and the write - Node never starts a second request's handler
 * body until the first one's synchronous code has fully returned, so two concurrent /save-partial calls can't
 * interleave their read-modify-write halves. The hash check only protects against a *stale* client; this
 * synchronous-handler property is what protects two fresh, hash-valid requests from racing each other on the
 * read (whichever one's handler runs first will have already changed the on-disk hash by the time the second
 * one's per-key check runs, so a genuine overlap still gets caught even under a race). This guarantee is
 * specific to a single Node process - if this server ever runs clustered across multiple worker processes, it
 * would need real cross-process file locking instead.
 */
router.post('/save-partial', function (request, response) {
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);

        const { keys, expectedHashes } = request.body ?? {};
        if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
            return response.status(400).send({
                result: 'error',
                error: 'Partial update body must include a "keys" object of top-level settings keys to merge.',
            });
        }

        const currentContent = fs.existsSync(pathToSettings) ? fs.readFileSync(pathToSettings, 'utf8') : '';
        let currentSettings = {};
        if (currentContent) {
            try {
                currentSettings = JSON.parse(currentContent);
            } catch (err) {
                console.error('Could not parse current settings.json for partial merge', err);
                return response.status(500).send({ result: 'error', error: 'Current settings.json is not valid JSON, cannot merge.' });
            }
        }

        if (expectedHashes && typeof expectedHashes === 'object' && !Array.isArray(expectedHashes)) {
            const actualHashes = hashSettingsKeys(currentSettings, Object.keys(expectedHashes));
            const conflictingKeys = Object.keys(expectedHashes).filter(key => actualHashes[key] !== expectedHashes[key]);
            if (conflictingKeys.length > 0) {
                return response.status(409).send({
                    result: 'conflict',
                    error: 'Some of the settings keys in this update were changed by another session since this client last saw them.',
                    conflictingKeys,
                });
            }
        }

        const mergedSettings = { ...currentSettings, ...keys };
        writeFileAtomicSync(pathToSettings, JSON.stringify(mergedSettings, null, 4), 'utf8');
        triggerAutoSave(request.user.profile.handle);
        response.send({ result: 'ok' });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

// Wintermute's code
router.post('/get', (request, response) => {
    let settings;
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        settings = fs.readFileSync(pathToSettings, 'utf8');
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

        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        const parsedSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

        // Import tags/tag_map out of the snapshot into the metadata store (see splitTagsFromSnapshot's own
        // comment) before writing the remaining settings content, so the restored settings.json matches the
        // post-cutover shape and the restored snapshot's tag data is applied either way.
        const settingsOnly = await splitTagsFromSnapshot(request.user.profile.handle, request.user.directories, parsedSnapshot);

        fs.rmSync(pathToSettings, { force: true });
        writeFileAtomicSync(pathToSettings, JSON.stringify(settingsOnly, null, 4), 'utf8');

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
