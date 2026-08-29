import express from 'express';

import {
    assignEntityTag,
    unassignEntityTag,
    getEntityTagIdsForMany,
    getAllEntityTagAssignments,
    getAssignedTagIds,
    getAllTagUsage,
    getTagDefinitions,
    saveTagDefinitions,
    getTagsHash,
    restoreTagMap,
} from '../character-metadata-db.js';

export const router = express.Router();

/**
 * Given a parsed settings snapshot being restored, imports its `tags`/`tag_map` fields (if present) into the
 * metadata store (tag definitions replace-all via saveTagDefinitions(), tag_map merged additively via
 * restoreTagMap() - see that function's own doc comment on why additive) and returns the remaining settings
 * content with those fields stripped. Backward-compat only at this point: current backups (settings.js's
 * backupUserSettings()) no longer embed tags/tag_map at all - character_tags/group_tags in the metadata store
 * already are the durable record, so there's nothing left to merge in at backup time (see that function's own
 * doc comment). This stays so an OLDER snapshot that still carries those fields - made before that change, or a
 * pre-phase-3 tags.json-era one - still restores its tag data correctly.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} settingsContent Parsed contents of the settings snapshot being restored
 * @returns {Promise<object>} settingsContent with tags/tag_map removed
 */
export async function splitTagsFromSnapshot(handle, directories, settingsContent) {
    const { tags, tag_map, ...rest } = settingsContent;

    if (Array.isArray(tags)) {
        await saveTagDefinitions(directories, tags);
    }
    if (tag_map && typeof tag_map === 'object') {
        await restoreTagMap(directories, tag_map);
    }

    return rest;
}

/**
 * Replaces the entire set of tag *definitions* (name/color/folder_type/... - see character-metadata-db.js's
 * `tags` table). Assignments (`tag_map`, pre-phase-3) are no longer accepted here at all - they moved to
 * `/assign`/`/unassign` as single-row writes, replacing what used to be a whole-tags.json rewrite on every
 * mutation (see those routes below).
 */
router.post('/save', async function (request, response) {
    try {
        if (!Array.isArray(request.body?.tags)) {
            return response.status(400).send({ error: 'tags must be an array' });
        }

        const result = await saveTagDefinitions(request.user.directories, request.body.tags);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        // A tag rename/delete/reassignment can change what the `#tags` field of any character or group search
        // index entry resolves to. No explicit invalidation call needed here - the character/group search
        // indexes (characters-search-index.js/groups-search-index.js) check getTagsHash() as part of their
        // freshness signature on every search, so this write is picked up automatically.
        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not save tag definitions', err);
        response.status(500).send({ error: 'Could not save tag definitions' });
    }
});

router.post('/get', async (request, response) => {
    try {
        const tags = await getTagDefinitions(request.user.directories);
        if (tags === null) {
            return response.send({ tags: null });
        }

        const assignedTagIds = await getAssignedTagIds(request.user.directories);
        response.send({ tags, assignedTagIds: assignedTagIds ?? [] });
    } catch (err) {
        console.error('Could not read tag definitions', err);
        response.sendStatus(500);
    }
});

/**
 * Lightweight freshness check for the client's tags cache (see loadTagsSettings() in tags.js) - `tags_rev`
 * (character-metadata-db.js) replaces tags.json's own mtime as the "has anything changed" signal now that
 * there's no file to stat. It's a sha256 content hash of the definitions table, recomputed on any tag
 * definition save or assign/unassign path (see getTagsHash()'s doc comment for the full list of callers),
 * but only actually changes when definitions change - assignment-only operations leave the hash unchanged, so
 * the client cache stays valid through tag/untag activity that doesn't touch definitions.
 *
 * Returns `{ mtime: null }` if the metadata store is unavailable (matches `/get`'s `{ tags: null }`).
 */
router.post('/manifest', async (request, response) => {
    try {
        const hash = await getTagsHash(request.user.directories);
        response.send({ hash });
    } catch (err) {
        console.error('Could not get tags revision', err);
        response.sendStatus(500);
    }
});

/**
 * Phase 3 (design doc §3.4/Phase 3, extended by owner decision to groups): the tag ids assigned to each of a
 * batch of entities, read straight from `character_tags`/`group_tags` (character-metadata-db.js) rather than
 * from tags.json's `tag_map` - those tables are now the source of truth for tag assignments; tags.json is gone
 * entirely. `ids` can freely mix character avatars and group ids. Every requested id comes back as a key, `[]`
 * if untagged (or unknown) - callers never need to distinguish "no tags" from "id not found".
 */
router.post('/for', async (request, response) => {
    try {
        const { ids } = request.body;
        if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
            return response.status(400).send({ error: 'ids must be an array of strings' });
        }

        const result = await getEntityTagIdsForMany(request.user.directories, ids);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send(result);
    } catch (err) {
        console.error('Could not resolve tags for entities', err);
        response.sendStatus(500);
    }
});

/**
 * Compact bulk read of every entity-to-tag assignment across `character_tags`/`group_tags`, for callers that
 * want the whole tag map up front rather than one `/for` batch per id list - see getAllEntityTagAssignments()'s
 * doc comment (character-metadata-db.js) for the `avatars`/`tagIds`/`map` index-interned response shape.
 */
router.post('/for-all', async (request, response) => {
    try {
        const result = await getAllEntityTagAssignments(request.user.directories);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        response.send(result);
    } catch (err) {
        console.error('Could not load all tag assignments', err);
        response.sendStatus(500);
    }
});

/**
 * Phase 3 (extended by owner decision to groups): single-row write assigning one tag to one character or group,
 * replacing the old whole-tags.json rewrite this mutation used to cost.
 */
router.post('/assign', async (request, response) => {
    try {
        const { id, tagId } = request.body;
        if (typeof id !== 'string' || !id || typeof tagId !== 'string' || !tagId) {
            return response.status(400).send({ error: 'id and tagId are required non-empty strings' });
        }

        const result = await assignEntityTag(request.user.directories, id, tagId);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (result === 'not_found') {
            return response.status(404).send({ error: 'Character or group not found' });
        }

        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not assign tag', err);
        response.sendStatus(500);
    }
});

/**
 * Phase 3 (extended by owner decision to groups): single-row write unassigning one tag from one character or
 * group. Not a 404 on an unknown entity - see unassignEntityTag()'s doc comment.
 */
router.post('/unassign', async (request, response) => {
    try {
        const { id, tagId } = request.body;
        if (typeof id !== 'string' || !id || typeof tagId !== 'string' || !tagId) {
            return response.status(400).send({ error: 'id and tagId are required non-empty strings' });
        }

        const result = await unassignEntityTag(request.user.directories, id, tagId);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not unassign tag', err);
        response.sendStatus(500);
    }
});

/**
 * Phase 3: the trigger-maintained `tag_usage` aggregate (design doc §3.4 - "this one aggregate subsumes three
 * separate full scans"), now counting assignments from both characters and groups (see character_tags'/
 * group_tags' shared triggers).
 */
router.get('/usage', async (request, response) => {
    try {
        const result = await getAllTagUsage(request.user.directories);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send(result);
    } catch (err) {
        console.error('Could not get tag usage', err);
        response.sendStatus(500);
    }
});
