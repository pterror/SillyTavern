import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { TAGS_FILE } from '../constants.js';
import { getUserDirectories } from '../users.js';
import { removeOldBackups } from '../util.js';

export const router = express.Router();

/**
 * Gets backup file prefix for a user's tags.json snapshots. Mirrors getSettingsBackupFilePrefix in settings.js -
 * kept as its own prefix (not reusing the settings one) so tags snapshots list/prune independently, but see
 * backupUserTags()/restoreUserTagsForSnapshot() for how the two are paired up by timestamp.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getTagsBackupFilePrefix(handle) {
    return `tags_${handle}_`;
}

/**
 * Makes a backup of the user's tags.json, using a `timestamp` supplied by the caller (settings.js's
 * backupUserSettings) rather than generating its own - the two backups need the *same* timestamp suffix so
 * restoreUserTagsForSnapshot() can find the tags snapshot that goes with a given settings snapshot. No-ops if
 * tags.json doesn't exist yet (fresh install, or no tag mutation has fired the save subscriber yet).
 * @param {string} handle User handle
 * @param {string} timestamp Same timestamp used for the paired settings.json backup (see generateTimestamp())
 * @returns {void}
 */
export function backupUserTags(handle, timestamp) {
    const userDirectories = getUserDirectories(handle);
    const sourceFile = path.join(userDirectories.root, TAGS_FILE);

    if (!fs.existsSync(sourceFile)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getTagsBackupFilePrefix(handle)}${timestamp}.json`);
    fs.copyFileSync(sourceFile, backupFile);
    removeOldBackups(userDirectories.backups, `tags_${handle}`);
}

/**
 * Restores tags.json to match a settings.json snapshot being restored (see restore-snapshot below), so
 * restoring an old settings snapshot never orphans the live tags data:
 * - If a tags backup with the same timestamp exists (the snapshot postdates the tags.json split), restores it.
 * - Otherwise (the snapshot predates the split, so there's no paired tags backup) falls back to whatever
 *   `tags`/`tag_map` fields are embedded in the settings snapshot itself and writes those to tags.json instead.
 * @param {string} handle User handle
 * @param {string} settingsSnapshotName e.g. `settings_{handle}_{timestamp}.json`, as passed to /restore-snapshot
 * @param {object} parsedSnapshotSettings Parsed contents of the settings snapshot being restored
 * @returns {void}
 */
export function restoreUserTagsForSnapshot(handle, settingsSnapshotName, parsedSnapshotSettings) {
    const userDirectories = getUserDirectories(handle);
    const settingsPrefix = `settings_${handle}_`;
    const timestamp = settingsSnapshotName.startsWith(settingsPrefix) && settingsSnapshotName.endsWith('.json')
        ? settingsSnapshotName.slice(settingsPrefix.length, -'.json'.length)
        : null;
    const pathToTags = path.join(userDirectories.root, TAGS_FILE);

    if (timestamp) {
        const pairedBackup = path.join(userDirectories.backups, `${getTagsBackupFilePrefix(handle)}${timestamp}.json`);
        if (fs.existsSync(pairedBackup)) {
            fs.rmSync(pathToTags, { force: true });
            fs.copyFileSync(pairedBackup, pathToTags);
            return;
        }
    }

    if (parsedSnapshotSettings && (parsedSnapshotSettings.tags !== undefined || parsedSnapshotSettings.tag_map !== undefined)) {
        const payload = {
            tags: parsedSnapshotSettings.tags ?? [],
            tag_map: parsedSnapshotSettings.tag_map ?? {},
        };
        writeFileAtomicSync(pathToTags, JSON.stringify(payload, null, 4), 'utf8');
    }
}

/**
 * Writes `{ tags, tag_map }` to the user's tags.json - the source of truth for tags/tag_map as of the load-side
 * cutover in tags.js (loadTagsSettings/saveTagsDebounced). settings.json no longer carries these fields going
 * forward; see restoreUserTagsForSnapshot() above for how an old settings.json snapshot (which may still have
 * them embedded) gets reconciled back into this file on restore.
 */
router.post('/save', function (request, response) {
    try {
        if (!Object.prototype.hasOwnProperty.call(request.body, 'tags') || !Object.prototype.hasOwnProperty.call(request.body, 'tag_map')) {
            return response.status(400).send({ error: 'Both tags and tag_map are required' });
        }

        const pathToTags = path.join(request.user.directories.root, TAGS_FILE);
        const payload = {
            tags: request.body.tags,
            tag_map: request.body.tag_map,
        };
        writeFileAtomicSync(pathToTags, JSON.stringify(payload, null, 4), 'utf8');
        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not save tags file', err);
        response.status(500).send({ error: 'Could not save tags file' });
    }
});

router.post('/get', (request, response) => {
    try {
        const pathToTags = path.join(request.user.directories.root, TAGS_FILE);

        if (!fs.existsSync(pathToTags)) {
            return response.send({ tags: null, tag_map: null });
        }

        const content = fs.readFileSync(pathToTags, 'utf8');
        const parsed = JSON.parse(content);
        response.send({ tags: parsed.tags ?? null, tag_map: parsed.tag_map ?? null });
    } catch (err) {
        console.error('Could not read tags file', err);
        response.sendStatus(500);
    }
});
