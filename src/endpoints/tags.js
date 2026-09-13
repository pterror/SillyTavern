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
    upsertTagDefinition,
    deleteTagDefinition,
    getTagsHash,
    getTagsDigest,
    getTagsBucketMembers,
    getTagDefinitionsByIds,
} from '../character-metadata-db.js';

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

/** Creates or edits one tag definition (create/rename/recolor), instead of replacing the whole set via `/save`. */
router.post('/upsert', async (request, response) => {
    try {
        const tag = request.body?.tag;
        if (!tag || typeof tag.id !== 'string' || !tag.id) {
            return response.status(400).send({ error: 'tag with a non-empty id is required' });
        }

        const result = await upsertTagDefinition(request.user.directories, tag);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not upsert tag definition', err);
        response.status(500).send({ error: 'Could not upsert tag definition' });
    }
});

/** Deletes one tag definition by id, instead of replacing the whole set via `/save`. */
router.post('/delete', async (request, response) => {
    try {
        const id = request.body?.id;
        if (typeof id !== 'string' || !id) {
            return response.status(400).send({ error: 'id is required' });
        }

        const result = await deleteTagDefinition(request.user.directories, id);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }

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

        const assignedTagIds = await getAssignedTagIds(request.user.directories);
        response.send({ tags, assignedTagIds: assignedTagIds ?? [] });
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

/** The definitions for a named set of ids. */
router.post('/by-ids', async (request, response) => {
    try {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
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

/** Tag ids assigned to a batch of entities (character avatars and/or group ids). Unknown ids come back as `[]`. */
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
