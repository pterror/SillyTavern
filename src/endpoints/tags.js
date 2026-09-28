import express from 'express';

import {
    assignEntityTag,
    unassignEntityTag,
    setEntityTagIdsMany,
    getEntityTagIdsForMany,
    getAllEntityTagAssignments,
    getAllTagUsage,
    getTagDefinitions,
    saveTagDefinitions,
    createTagDefinition,
    editTagDefinition,
    moveTagDefinition,
    reorderTagDefinitions,
    deleteTagDefinition,
    countUnusedTags,
    pruneUnusedTags,
    getTagsHash,
    getTagsDigest,
    getTagsBucketMembers,
    getTagDefinitionsByIds,
    queryTags,
    decodeTagQueryCursor,
    TAG_QUERY_SORTS,
    TAG_REORDER_MODES,
} from '../character-metadata-db.js';
import { requestMetadataMigrationPass } from '../metadata-migration-coordinator.js';

export const router = express.Router();

/** Replaces tag *definitions* only; assignments go through `/assign`/`/unassign`. */
router.post('/save', async function (request, response) {
    try {
        if (!Array.isArray(request.body?.tags)) {
            return response.status(400).send({ error: 'tags must be an array' });
        }

        const result = await saveTagDefinitions(request.user.directories, request.body.tags);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        // Search indexes key off getTagsHash(), so no explicit invalidation is needed here.
        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not save tag definitions', err);
        response.status(500).send({ error: 'Could not save tag definitions' });
    }
});

/** `{ tag }` → `{ result, refused: [{ id, reason: 'deleted' | 'exists' }] }`. */
router.post('/create', async (request, response) => {
    try {
        const tag = request.body?.tag;
        if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || !tag.id) {
            return response.status(400).send({ error: 'tag with a non-empty id is required' });
        }

        const result = await createTagDefinition(request.user.directories, tag);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send({ result: 'ok', refused: result.refused });
    } catch (err) {
        console.error('Could not create tag definition', err);
        response.status(500).send({ error: 'Could not create tag definition' });
    }
});

/**
 * `{ id, patch }` → `{ result, refused: [{ id, reason: 'deleted' | 'missing' | 'unreadable' }] }`. `patch` holds only
 * the changed fields; the rest keep their stored values.
 */
router.post('/edit', async (request, response) => {
    try {
        const id = request.body?.id;
        const patch = request.body?.patch;
        if (typeof id !== 'string' || !id) {
            return response.status(400).send({ error: 'id is required' });
        }
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            return response.status(400).send({ error: 'patch must be an object' });
        }
        if (Object.hasOwn(patch, 'id') && patch.id !== id) {
            return response.status(400).send({ error: 'patch.id must match id' });
        }

        const result = await editTagDefinition(request.user.directories, id, patch);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send({ result: 'ok', refused: result.refused });
    } catch (err) {
        console.error('Could not edit tag definition', err);
        response.status(500).send({ error: 'Could not edit tag definition' });
    }
});

/**
 * `{ id, before }` or `{ id, after }` → `{ result, refused: [{ id, reason: 'same' | 'deleted' | 'missing' |
 * 'unreadable' | 'unordered' | 'no-room' }], queued }`. Puts tag `id` right before or after the anchor tag (by id)
 * in the manual order. queued: the move arrived before the tag sort_order fill finished or while a reorder pass is
 * recorded, and is applied when that pass ends (moveTagDefinition()).
 */
router.post('/move', async (request, response) => {
    try {
        const id = request.body?.id;
        const before = request.body?.before;
        const after = request.body?.after;
        if (typeof id !== 'string' || !id) {
            return response.status(400).send({ error: 'id is required' });
        }
        if ((before === undefined) === (after === undefined)) {
            return response.status(400).send({ error: 'exactly one of before or after is required' });
        }
        const anchorId = before !== undefined ? before : after;
        if (typeof anchorId !== 'string' || !anchorId) {
            return response.status(400).send({ error: 'before or after must be a non-empty tag id' });
        }

        const result = await moveTagDefinition(request.user.directories, id, before !== undefined ? { before } : { after });
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send({ result: 'ok', refused: result.refused, queued: result.queued === true });
    } catch (err) {
        console.error('Could not move tag definition', err);
        response.status(500).send({ error: 'Could not move tag definition' });
    }
});

/**
 * `{ id, before | after, mode }` → `{ result, refused: [{ id, reason: 'same' | 'deleted' | 'missing' | 'unreadable' }],
 * queued }`. A reorder made while viewing `mode` ('alphabetical' or 'by_entries'): the tags get a manual order
 * matching `mode`, with tag `id` right before or after the anchor tag (by id). queued: it was accepted, and is
 * applied later (reorderTagDefinitions()); false when refused.
 */
router.post('/reorder', async (request, response) => {
    try {
        const id = request.body?.id;
        const before = request.body?.before;
        const after = request.body?.after;
        const mode = request.body?.mode;
        if (typeof id !== 'string' || !id) {
            return response.status(400).send({ error: 'id is required' });
        }
        if ((before === undefined) === (after === undefined)) {
            return response.status(400).send({ error: 'exactly one of before or after is required' });
        }
        const anchorId = before !== undefined ? before : after;
        if (typeof anchorId !== 'string' || !anchorId) {
            return response.status(400).send({ error: 'before or after must be a non-empty tag id' });
        }
        if (!TAG_REORDER_MODES.includes(mode)) {
            return response.status(400).send({ error: `mode must be one of ${TAG_REORDER_MODES.join(', ')}` });
        }

        const result = await reorderTagDefinitions(request.user.directories, id, before !== undefined ? { before } : { after }, mode);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (result.queued) {
            // Not awaited: the pass writes every tag's sort_order in a worker, after this responds.
            requestMetadataMigrationPass(request.user.directories, 'runTagReorderPassIfNeeded')
                .catch(err => console.error('Could not run the tag reorder pass', err));
        }

        response.send({ result: 'ok', refused: result.refused, queued: result.queued });
    } catch (err) {
        console.error('Could not reorder tag definitions', err);
        response.status(500).send({ error: 'Could not reorder tag definitions' });
    }
});

router.post('/unused-count', async (request, response) => {
    try {
        const count = await countUnusedTags(request.user.directories);
        if (count === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        response.send({ count });
    } catch (err) {
        console.error('Could not count unused tags', err);
        response.sendStatus(500);
    }
});

const PRUNE_MAX_LIMIT = 500;

/** Deletes up to `limit` unused tag definitions; `more` says whether another call could delete more. */
router.post('/prune', async (request, response) => {
    try {
        const limit = Number(request.body?.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > PRUNE_MAX_LIMIT) {
            return response.status(400).send({ error: `limit must be an integer from 1 to ${PRUNE_MAX_LIMIT}` });
        }
        const deleted = await pruneUnusedTags(request.user.directories, limit);
        if (deleted === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        response.send({ deleted, more: deleted.length === limit });
    } catch (err) {
        console.error('Could not prune unused tags', err);
        response.sendStatus(500);
    }
});

/**
 * Deletes one tag definition by id, instead of replacing the whole set via `/save`. `mergeInto`, when given, is the
 * tag every entity carrying the deleted one gets instead, as upstream's delete-and-merge does.
 */
router.post('/delete', async (request, response) => {
    try {
        const id = request.body?.id;
        if (typeof id !== 'string' || !id) {
            return response.status(400).send({ error: 'id is required' });
        }
        const mergeInto = request.body?.mergeInto ?? null;
        if (mergeInto !== null && typeof mergeInto !== 'string') {
            return response.status(400).send({ error: 'mergeInto must be a string or null' });
        }

        const result = await deleteTagDefinition(request.user.directories, id, mergeInto);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        // Not awaited: the pass moves the deleted tag's rows onto its merge target in a worker, after this responds.
        requestMetadataMigrationPass(request.user.directories, 'finishDeletedTags')
            .catch(err => console.error('Could not run the deleted tag finishing pass', err));

        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not delete tag definition', err);
        response.status(500).send({ error: 'Could not delete tag definition' });
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

/** Bucketed digest of every tag definition, for cheap client-side cache verification. */
router.post('/digest', async (request, response) => {
    try {
        const bucketCount = Number(request.body?.bucketCount);
        const digest = await getTagsDigest(
            request.user.directories,
            Number.isFinite(bucketCount) && bucketCount > 0 ? Math.trunc(bucketCount) : undefined,
        );
        if (digest === null) {
            return response.send({ digest: null });
        }
        response.send(digest);
    } catch (err) {
        console.error('Could not compute the tag digest', err);
        response.sendStatus(500);
    }
});

/** The {id, hash} membership of one bucket, for a client whose digest disagreed. */
router.post('/bucket', async (request, response) => {
    try {
        const bucket = Number(request.body?.bucket);
        if (!Number.isFinite(bucket) || bucket < 0) {
            return response.status(400).send({ error: true, reason: 'bucket-required' });
        }
        const bucketCount = Number(request.body?.bucketCount);
        const result = await getTagsBucketMembers(
            request.user.directories,
            Math.trunc(bucket),
            Number.isFinite(bucketCount) && bucketCount > 0 ? Math.trunc(bucketCount) : undefined,
        );
        if (result === null) {
            return response.send({ members: null });
        }
        response.send(result);
    } catch (err) {
        console.error('Could not read tag bucket members', err);
        response.sendStatus(500);
    }
});

const DEFAULT_QUERY_PAGE_SIZE = 50;
const MAX_QUERY_PAGE_SIZE = 500;
const QUERY_MAX_IDS = 500;

/**
 * One page of tag definitions: `{ filter: { search, name, ids, used, folders }, sort: { field }, pageSize, cursor }`
 * → `{ rows, cursor, more }`. `sort.field` is a tag_sort_mode value, manual by default. `cursor` is the one a
 * previous page returned, for the same sort; a manual one is refused (400 invalid-cursor) once the manual order it
 * was made in is no longer the one read, i.e. when a tag reorder pass starts or starts draining. `more` means the server's work cap cut the page short and `cursor`
 * carries on; otherwise a null `cursor` is the end.
 */
router.post('/query', async (request, response) => {
    try {
        const body = request.body ?? {};
        const filter = body.filter ?? {};
        const sortField = body.sort?.field ?? 'manual';
        if (!TAG_QUERY_SORTS.includes(sortField)) {
            return response.status(400).send({ error: true, reason: 'invalid-sort-field' });
        }
        if (filter.search !== undefined && typeof filter.search !== 'string') {
            return response.status(400).send({ error: true, reason: 'invalid-search' });
        }
        if (filter.name !== undefined && typeof filter.name !== 'string') {
            return response.status(400).send({ error: true, reason: 'invalid-name' });
        }
        for (const flag of ['used', 'folders']) {
            if (filter[flag] !== undefined && typeof filter[flag] !== 'boolean') {
                return response.status(400).send({ error: true, reason: `invalid-${flag}` });
            }
        }
        let ids;
        if (filter.ids !== undefined) {
            if (!Array.isArray(filter.ids) || !filter.ids.every(id => typeof id === 'string')) {
                return response.status(400).send({ error: true, reason: 'invalid-ids', message: 'filter.ids must be an array of strings' });
            }
            ids = [...new Set(filter.ids)];
            if (ids.length > QUERY_MAX_IDS) {
                return response.status(400).send({ error: true, reason: 'too-many-ids', message: `at most ${QUERY_MAX_IDS} distinct ids per request` });
            }
        }
        let after = null;
        if (body.cursor !== undefined && body.cursor !== null) {
            after = decodeTagQueryCursor(body.cursor, sortField);
            if (after === null) {
                return response.status(400).send({ error: true, reason: 'invalid-cursor' });
            }
        }
        const pageSize = Number.isFinite(Number(body.pageSize)) && Number(body.pageSize) >= 1
            ? Math.min(Math.trunc(Number(body.pageSize)), MAX_QUERY_PAGE_SIZE)
            : DEFAULT_QUERY_PAGE_SIZE;

        const result = await queryTags(request.user.directories, {
            sort: sortField,
            search: filter.search?.trim() || undefined,
            name: filter.name,
            ids,
            used: filter.used === true,
            folders: filter.folders === true,
            pageSize,
            after,
        });
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        if (result === 'invalid-cursor') {
            return response.status(400).send({ error: true, reason: 'invalid-cursor' });
        }
        response.send(result);
    } catch (err) {
        console.error('Could not query tag definitions', err);
        response.status(500).send({ error: true });
    }
});

const BY_IDS_MAX_IDS = 500;

/**
 * The definitions for a named set of ids. More than BY_IDS_MAX_IDS distinct ids is a 400 rather than a truncated
 * answer, which would read as those tags not existing.
 */
router.post('/by-ids', async (request, response) => {
    try {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
        if (new Set(ids.map(String)).size > BY_IDS_MAX_IDS) {
            return response.status(400).send({ error: `at most ${BY_IDS_MAX_IDS} distinct ids per request` });
        }
        const tags = await getTagDefinitionsByIds(request.user.directories, ids);
        if (tags === null) {
            return response.send({ tags: null });
        }
        response.send({ tags });
    } catch (err) {
        console.error('Could not read tag definitions by id', err);
        response.sendStatus(500);
    }
});

/** Freshness check for the client's tags cache; only changes when definitions change, not assignments. */
router.post('/manifest', async (request, response) => {
    try {
        const hash = await getTagsHash(request.user.directories);
        response.send({ hash });
    } catch (err) {
        console.error('Could not get tags revision', err);
        response.sendStatus(500);
    }
});

const FOR_MAX_IDS = 500;

/**
 * Tag ids assigned to a batch of entities (character avatars and/or group ids). Unknown ids come back as `[]`.
 * More than FOR_MAX_IDS distinct ids is a 400 rather than a truncated answer, which would read as those entities
 * having no tags.
 */
router.post('/for', async (request, response) => {
    try {
        const { ids } = request.body;
        if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
            return response.status(400).send({ error: 'ids must be an array of strings' });
        }
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length > FOR_MAX_IDS) {
            return response.status(400).send({ error: `at most ${FOR_MAX_IDS} distinct ids per request` });
        }

        const result = await getEntityTagIdsForMany(request.user.directories, uniqueIds);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send(result);
    } catch (err) {
        console.error('Could not resolve tags for entities', err);
        response.sendStatus(500);
    }
});

/** Bulk read of every entity-to-tag assignment, for callers that want the whole map up front. */
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

/** Unlike /assign, an unknown entity is not treated as a 404 here. */
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

// Bulk counterpart to /assign and /unassign, for a multi-entity, whole-tag-set write (e.g. restoring a tag
// backup file) instead of looping single-tag calls per tag per entity.
router.post('/assign-many', async (request, response) => {
    try {
        const { tagIdsByEntity } = request.body;
        if (typeof tagIdsByEntity !== 'object' || tagIdsByEntity === null || Array.isArray(tagIdsByEntity)) {
            return response.status(400).send({ error: 'tagIdsByEntity must be an object' });
        }
        for (const [id, tagIds] of Object.entries(tagIdsByEntity)) {
            if (!id || !Array.isArray(tagIds) || !tagIds.every(t => typeof t === 'string' && t)) {
                return response.status(400).send({ error: 'tagIdsByEntity must map non-empty entity ids to arrays of non-empty string tag ids' });
            }
        }

        const result = await setEntityTagIdsMany(request.user.directories, tagIdsByEntity);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send({ result });
    } catch (err) {
        console.error('Could not bulk-assign tags', err);
        response.sendStatus(500);
    }
});

router.get('/usage', async (request, response) => {
    try {
        const result = await getAllTagUsage(request.user.directories);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        // The ids whose count may be too high (see getAllTagUsage()), as a JSON array, so the body stays {id: count}.
        response.set('X-Tag-Usage-Approximate', JSON.stringify(result.approximate));
        response.send(result.counts);
    } catch (err) {
        console.error('Could not get tag usage', err);
        response.sendStatus(500);
    }
});
