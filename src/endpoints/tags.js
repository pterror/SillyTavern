import express from 'express';

import {
    assignEntityTag,
    unassignEntityTag,
    getEntityTagIdsForMany,
    getAllTagUsage,
    getTagDefinitions,
    saveTagDefinitions,
    getTagsRevision,
    getFullTagMapExport,
    restoreTagMap,
} from '../character-metadata-db.js';

export const router = express.Router();

/**
 * Returns a copy of `settingsContent` (parsed settings.json) with its `tags`/`tag_map` fields set to the user's
 * live tag data, pulled from the per-user metadata sqlite store now that tags.json is gone entirely (owner
 * decision, phase 3 - see character-metadata-db.js's header on the `tags`/`group_tags`/`character_tags` tables
 * and migrateTagsJsonIfNeeded()). Used when writing a settings snapshot so each snapshot stays a single file
 * that fully captures state, same property tags.json-backed snapshots always had - just sourced differently.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} settingsContent Parsed settings.json content
 * @returns {Promise<object>} settingsContent with tags/tag_map merged in
 */
export async function mergeTagsIntoSnapshot(handle, directories, settingsContent) {
    try {
        const [tags, tagMap] = await Promise.all([
            getTagDefinitions(directories),
            getFullTagMapExport(directories),
        ]);
        if (tags === null || tagMap === null) {
            // Metadata store unavailable this run - same "leave settingsContent as-is" fallback the old
            // fs.existsSync(tags.json)-missing branch used.
            return settingsContent;
        }
        return { ...settingsContent, tags, tag_map: tagMap };
    } catch (err) {
        console.error('Could not merge tag data into settings snapshot', err);
        return settingsContent;
    }
}

/**
 * The inverse of mergeTagsIntoSnapshot(): given a parsed settings snapshot being restored, imports its
 * `tags`/`tag_map` fields into the metadata store (tag definitions replace-all via saveTagDefinitions(), tag_map
 * merged additively via restoreTagMap() - see that function's own doc comment on why additive) and returns the
 * remaining settings content with those fields stripped. Works the same whether the snapshot predates or
 * postdates the tags.json split - either way, whatever tags/tag_map ends up embedded in the snapshot is applied.
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
        // indexes (characters-search-index.js/groups-search-index.js) check getTagsRevision() as part of their
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

        response.send({ tags });
    } catch (err) {
        console.error('Could not read tag definitions', err);
        response.sendStatus(500);
    }
});

/**
 * Lightweight freshness check for the client's tags cache (see loadTagsSettings() in tags.js) - `tags_rev`
 * (character-metadata-db.js) replaces tags.json's own mtime as the "has anything changed" signal now that
 * there's no file to stat. Bumped by any tag definition save or any assign/unassign (see getTagsRevision()'s
 * doc comment for the full list of writers), matching the old whole-file "invalidate everything on any change"
 * granularity - tag edits are still far less frequent/voluminous than character edits, so this coarseness is
 * still an acceptable tradeoff, same reasoning as before the sqlite migration.
 *
 * Returns `{ mtime: null }` if the metadata store is unavailable (matches `/get`'s `{ tags: null }`).
 */
router.post('/manifest', async (request, response) => {
    try {
        const rev = await getTagsRevision(request.user.directories);
        response.send({ mtime: rev });
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
