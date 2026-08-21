import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { TAGS_FILE } from '../constants.js';
import { getUserDirectories } from '../users.js';
import { readTagsData } from './tags-data.js';

export const router = express.Router();

/**
 * Returns a copy of `settingsContent` (parsed settings.json) with its `tags`/`tag_map` fields set to the
 * user's live tags.json content, if that file exists. Used when writing a settings snapshot so each snapshot
 * stays a single file that fully captures state - same shape as before the tags.json split - rather than
 * needing a second paired backup file that has to be kept in sync by timestamp.
 * @param {string} handle User handle
 * @param {object} settingsContent Parsed settings.json content
 * @returns {object} settingsContent with tags/tag_map merged in from tags.json, if present
 */
export function mergeTagsIntoSnapshot(handle, settingsContent) {
    const userDirectories = getUserDirectories(handle);
    const pathToTags = path.join(userDirectories.root, TAGS_FILE);

    if (!fs.existsSync(pathToTags)) {
        return settingsContent;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(pathToTags, 'utf8'));
        return { ...settingsContent, tags: parsed.tags, tag_map: parsed.tag_map };
    } catch (err) {
        console.error('Could not merge tags.json into settings snapshot', err);
        return settingsContent;
    }
}

/**
 * The inverse of mergeTagsIntoSnapshot(): given a parsed settings snapshot being restored, writes its
 * `tags`/`tag_map` fields out to tags.json and returns the remaining settings content with those fields
 * stripped (matching the post-cutover settings.json shape, where tags live only in tags.json). Works the same
 * whether the snapshot predates or postdates the tags.json split - either way, whatever tags/tag_map ends up
 * embedded in the snapshot is what tags.json gets restored to, so a restore never orphans tags.
 * @param {string} handle User handle
 * @param {object} settingsContent Parsed contents of the settings snapshot being restored
 * @returns {object} settingsContent with tags/tag_map removed
 */
export function splitTagsFromSnapshot(handle, settingsContent) {
    const { tags, tag_map, ...rest } = settingsContent;

    if (tags !== undefined || tag_map !== undefined) {
        const userDirectories = getUserDirectories(handle);
        const pathToTags = path.join(userDirectories.root, TAGS_FILE);
        const payload = { tags: tags ?? [], tag_map: tag_map ?? {} };
        writeFileAtomicSync(pathToTags, JSON.stringify(payload, null, 4), 'utf8');
    }

    return rest;
}

/**
 * Writes `{ tags, tag_map }` to the user's tags.json - the source of truth for tags/tag_map as of the load-side
 * cutover in tags.js (loadTagsSettings/saveTagsDebounced). settings.json no longer carries these fields going
 * forward; see mergeTagsIntoSnapshot()/splitTagsFromSnapshot() above for how they still travel with a settings
 * snapshot as a single file for backup/restore.
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
        // A tag rename/delete/reassignment can change what the `#tags` field of any character or group search
        // index entry resolves to. No explicit invalidation call needed here - the character/group search
        // indexes (characters-search-index.js/groups-search-index.js) check tags.json's own mtime as part of
        // their freshness signature on every search, so this write is picked up automatically.
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

        const { tags, tag_map } = readTagsData(request.user.directories);
        response.send({ tags, tag_map });
    } catch (err) {
        console.error('Could not read tags file', err);
        response.sendStatus(500);
    }
});
