import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import bytes from 'bytes';

import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { CHAR_LORE_PATH, getStringHash, seedKeyHashes, settingsWithoutCharLore } from '../../public/scripts/hash-utils.js';
import {
    readAllSettingsAsJson,
    readSettingsAtPaths,
    writeSettingsKeys,
    writeAllSettings,
    writeNamedSettings,
    settingsExist,
} from '../settings-store.js';
import { requestStore, storeRoute, userStore } from '../user-stores.js';
import { listBundleFiles } from '../bundle-files.js';

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
 * Per user: when their settings were last backed up by an autosave, the one waiting for the interval to pass, and
 * their directories as the latest request had them.
 * @type {Map<string, { last: number, timer: NodeJS.Timeout | null, directories: import('../users.js').UserDirectoryList }>}
 */
const AUTOSAVES = new Map();

/**
 * Backs up a user's settings at most once every 10 minutes: now, if the last was longer ago, else once the 10 minutes
 * are up. A waiting backup doesn't keep the process running.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories The user's directories (the request's)
 * @returns {void}
 */
export function triggerAutoSave(handle, directories) {
    const entry = AUTOSAVES.get(handle) ?? { last: -Infinity, timer: null, directories };
    entry.directories = directories;
    AUTOSAVES.set(handle, entry);
    if (entry.timer !== null) return;
    const run = () => {
        entry.timer = null;
        entry.last = Date.now();
        backupUserSettings(handle, true, entry.directories).catch(err => console.error('Autosave failed', err));
    };
    const wait = entry.last + AUTOSAVE_INTERVAL - Date.now();
    if (wait <= 0) {
        run();
        return;
    }
    entry.timer = setTimeout(run, wait);
    entry.timer.unref();
}

/**
 * Settings as the page and backups read them: upstream's `world_info.charLore` filled in from the characters' links
 * (no settings file holds it), when any character has extra links. The settings hashes leave it out.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {Record<string, any>} settings
 * @returns {Promise<Record<string, any>>}
 */
export async function withCharLore(lib, settings) {
    const charLore = await lib.charLore();
    if (charLore.length === 0) return settings;
    const [top, mid, last] = CHAR_LORE_PATH;
    const wis = _.isPlainObject(settings[top]) ? settings[top] : {};
    const worldInfo = _.isPlainObject(wis[mid]) ? wis[mid] : {};
    return { ...settings, [top]: { ...wis, [mid]: { ...worldInfo, [last]: charLore } } };
}

/**
 * Logs one line when a settings save carried a `charLore` (not stored: characters' links are changed by
 * `/api/worldinfo/additional-books` only) that differs from the links of the characters it names.
 * @param {import('express').Request} request
 * @param {unknown} charLore What the save carried (undefined: none).
 */
async function reportIgnoredCharLore(request, charLore) {
    if (charLore === undefined) return;
    try {
        const { lib } = await requestStore(request);
        if (await lib.charLoreDiffers(charLore)) {
            console.warn('[settings] A save carried world_info.charLore that differs from the characters\' links: it was ignored. /api/worldinfo/additional-books changes them.');
        }
    } catch (err) {
        console.error('Could not compare a saved charLore with the characters\' links', err);
    }
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
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
 * Snapshots the reconstructed flat settings object (from the sharded settings/ store), not a raw file copy.
 * Tag definitions/assignments are never included - they live in the metadata store, not settings.
 * @param {string} handle
 * @param {boolean} preventDuplicates
 * @param {import('../users.js').UserDirectoryList} [userDirectories] The user's directories, when the caller has them.
 */
async function backupUserSettings(handle, preventDuplicates, userDirectories = getUserDirectories(handle)) {
    if (!fs.existsSync(userDirectories.root)) {
        return;
    }

    if (!settingsExist(userDirectories)) {
        return;
    }

    let snapshotContent;
    try {
        const { lib } = await userStore(userDirectories, handle);
        snapshotContent = JSON.stringify(await withCharLore(lib, JSON.parse(readAllSettingsAsJson(userDirectories))), null, 4);
    } catch (err) {
        console.error('Could not read settings for backup', err);
        return;
    }

    if (preventDuplicates && isDuplicateBackup(handle, snapshotContent, userDirectories)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    writeFileAtomicSync(backupFile, snapshotContent, 'utf8');
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/** Checks if the backup would be a duplicate of the latest existing one. */
export function isDuplicateBackup(handle, content, userDirectories = getUserDirectories(handle)) {
    const latestBackup = getLatestBackup(handle, userDirectories);
    if (!latestBackup || !fs.existsSync(latestBackup)) {
        return false;
    }
    return fs.readFileSync(latestBackup, 'utf8') === content;
}

/**
 * Gets the latest backup file for a user: the one whose name carries the newest timestamp. File times aren't
 * reliable for this (a copied or restored backups folder gets fresh ctimes in arbitrary order), so they are
 * only used for a name without a parseable timestamp.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} [userDirectories] The user's directories, when the caller has them.
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle, userDirectories = getUserDirectories(handle)) {
    const prefix = getSettingsBackupFilePrefix(handle);
    const backupFiles = fs.readdirSync(userDirectories.backups)
        .filter(x => x.startsWith(prefix))
        .map(x => ({ name: x, time: getBackupTime(path.join(userDirectories.backups, x), x.slice(prefix.length)) }));
    const latestBackup = backupFiles.sort((a, b) => b.time - a.time)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

/**
 * @param {string} filePath Backup file path
 * @param {string} suffix The file name after the backup prefix, e.g. `20260926-150503.json` (see generateTimestamp())
 * @returns {number} Epoch milliseconds
 */
function getBackupTime(filePath, suffix) {
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/.exec(suffix);
    if (match) {
        const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number);
        return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
    }
    return fs.statSync(filePath).mtimeMs;
}

export const router = express.Router();

/**
 * Optimistic-concurrency guard: compares the client's last-known settings hash (X-Settings-Hash) against the
 * current on-disk hash, rejecting a save whose view is stale. Header absent means skip the check (unconditional
 * overwrite, for backward compatibility).
 */
function checkSettingsConflict(request, directories) {
    const expectedHashHeader = request.get('X-Settings-Hash');
    if (expectedHashHeader === undefined) {
        return { ok: true };
    }

    const expectedHash = Number(expectedHashHeader);
    if (!Number.isFinite(expectedHash)) {
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

        // Keeps the key files the body leaves out: the client's full save has no tags, tag_map or accountStorage.
        // Its charLore isn't stored (writeNamedSettings() leaves it out).
        writeNamedSettings(directories, request.body);
        void reportIgnoredCharLore(request, settingsWithoutCharLore('', request.body).charLore);
        triggerAutoSave(request.user.profile.handle, request.user.directories);
        // Key order in the reconstructed store may differ from the client's payload, so the client can't just
        // hash its own JSON locally - it must use this returned hash.
        response.send({ result: 'ok', settingsHash: getStringHash(readAllSettingsAsJson(directories)) });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

/**
 * Partial-update alternative to /save: writes only the given top-level keys, leaving other keys' files untouched.
 * Conflict checking is per-key so two updates to disjoint keys can both succeed. Relies on the handler running
 * synchronously (no `await` between read and write) to keep concurrent calls from interleaving; would need real
 * locking if this process is ever clustered.
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
            // A charLore among the keys isn't stored (writeSettingsKeys() leaves it out).
            writeSettingsKeys(directories, keys);
        } catch (err) {
            console.error('Could not write partial settings update', err);
            return response.status(400).send({ result: 'error', error: err.message });
        }
        const carried = Object.entries(keys).map(([key, value]) => settingsWithoutCharLore(key, value).charLore).find(x => x !== undefined);
        void reportIgnoredCharLore(request, carried);

        triggerAutoSave(request.user.profile.handle, request.user.directories);
        // Same reasoning as /save's response above: return the server's own canonical whole-store hash so the
        // client's knownServerSettingsHash stays correct without needing to know how the store reconstructs it.
        response.send({ result: 'ok', settingsHash: getStringHash(readAllSettingsAsJson(directories)) });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

/**
 * Toggles one extension's membership in extension_settings.disabledExtensions. The server owns the
 * merge so the client only ever asserts the raw fact (which extension, enabled or not).
 */
router.post('/toggle-extension', function (request, response) {
    try {
        const directories = request.user.directories;
        const { name, enabled } = request.body ?? {};
        if (typeof name !== 'string' || !name) {
            return response.status(400).send({ result: 'error', error: 'Body must include a non-empty string "name".' });
        }
        if (typeof enabled !== 'boolean') {
            return response.status(400).send({ result: 'error', error: 'Body must include a boolean "enabled".' });
        }

        const path = 'extension_settings.disabledExtensions';
        const current = readSettingsAtPaths(directories, [path])[path];
        const disabledExtensions = Array.isArray(current) ? current : [];
        const nextDisabledExtensions = enabled
            ? disabledExtensions.filter(x => x !== name)
            : disabledExtensions.includes(name) ? disabledExtensions : [...disabledExtensions, name];

        writeSettingsKeys(directories, { [path]: nextDisabledExtensions });
        triggerAutoSave(request.user.profile.handle, request.user.directories);
        response.send({
            result: 'ok',
            disabledExtensions: nextDisabledExtensions,
            settingsHash: getStringHash(readAllSettingsAsJson(directories)),
        });
    } catch (err) {
        console.error(err);
        response.send(err);
    }
});

// Wintermute's code
router.post('/get', storeRoute('reading settings', async (request, response) => {
    let settings;
    try {
        settings = readAllSettingsAsJson(request.user.directories);
    } catch (e) {
        return response.sendStatus(500);
    }

    const { directories } = request.user;
    // Sampler presets as their files' text, by name in locale order; the other bundles parsed, in code-unit order.
    const presets = (/** @type {string} */ group) => {
        const listed = listBundleFiles(directories, group, { order: 'locale' });
        return { texts: listed.map(entry => entry.text), names: listed.map(entry => entry.name) };
    };
    const parsed = (/** @type {string} */ group) => listBundleFiles(directories, group).map(entry => entry.file);
    const { texts: novelai_settings, names: novelai_setting_names } = presets('preset.novel');
    const { texts: openai_settings, names: openai_setting_names } = presets('preset.openai');
    const { texts: textgenerationwebui_presets, names: textgenerationwebui_preset_names } = presets('preset.textgenerationwebui');
    const { texts: koboldai_settings, names: koboldai_setting_names } = presets('preset.kobold');

    const world_names = (await (await requestStore(request)).lib.books.list()).map(book => book.file_id);

    const themes = parsed('theme');
    const quickReplyPresets = parsed('quickReplies');

    const instruct = parsed('template.instruct');
    const context = parsed('template.context');
    const sysprompt = parsed('template.sysprompt');
    const reasoning = parsed('template.reasoning');

    // The hashes are of the settings as stored, without charLore; the page gets it filled in.
    const keyHashes = {};
    seedKeyHashes(keyHashes, JSON.parse(settings));
    const { lib } = await requestStore(request);
    const filled = JSON.stringify(await withCharLore(lib, JSON.parse(settings)), null, 4);

    response.send({
        settings: filled,
        settingsHash: getStringHash(settings),
        keyHashes,
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
}));

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
        await backupUserSettings(request.user.profile.handle, false, request.user.directories);
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
        const snapshotSettings = JSON.parse(snapshotContent);

        writeAllSettings(request.user.directories, snapshotSettings);

        // A restored snapshot holding tags is imported again; the import marks itself done once no source is left.
        if (snapshotSettings && typeof snapshotSettings === 'object'
            && (Object.hasOwn(snapshotSettings, 'tags') || Object.hasOwn(snapshotSettings, 'tag_map'))) {
            const { lib } = await requestStore(request);
            await lib.tags.restartSettingsImport();
            lib.tags.importSettingsTags(request.user.directories)
                .catch(err => console.error('Could not run the settings tags import', err));
        }

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
