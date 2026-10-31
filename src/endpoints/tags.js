import express from 'express';

import { requestStore } from '../user-stores.js';
import { TAG_REORDER_MODES, TAG_SORTS } from '../library-engine-tags.js';
import { writeBackpressured } from '../util.js';
import { pageAnswer, parsePageRequest } from '../catalog-page.js';

export const router = express.Router();

router.post('/create', async (request, response) => {
    try {
        const tag = request.body?.tag;
        if (!tag || typeof tag !== 'object' || typeof tag.id !== 'string' || !tag.id) {
            return response.status(400).send({ error: 'tag with a non-empty id is required' });
        }
        const freeName = request.body?.freeName;
        if (freeName !== undefined && typeof freeName !== 'boolean') {
            return response.status(400).send({ error: 'freeName must be a boolean' });
        }
        if (freeName === true && (typeof tag.name !== 'string' || !tag.name)) {
            return response.status(400).send({ error: 'freeName needs a non-empty tag.name to start from' });
        }

        const result = await (await requestStore(request)).lib.tags.create(tag, { freeName: freeName === true });
        if (result === null) {
            return response.status(400).send({ error: 'tag with a non-empty id is required' });
        }

        response.send({ result: 'ok', refused: result.refused, tag: result.tag });
    } catch (err) {
        console.error('Could not create tag definition', err);
        response.status(500).send({ error: 'Could not create tag definition' });
    }
});

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

        const result = await (await requestStore(request)).lib.tags.edit(id, patch);

        response.send({ result: 'ok', refused: result.refused });
    } catch (err) {
        console.error('Could not edit tag definition', err);
        response.status(500).send({ error: 'Could not edit tag definition' });
    }
});

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

        const result = await (await requestStore(request)).lib.tags.moveDefinition(id, before !== undefined ? { before } : { after });

        response.send({ result: 'ok', refused: result.refused, written: result.written, queued: result.queued === true });
    } catch (err) {
        console.error('Could not move tag definition', err);
        response.status(500).send({ error: 'Could not move tag definition' });
    }
});

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

        const { lib } = await requestStore(request);
        const result = await lib.tags.reorderDefinitions(id, before !== undefined ? { before } : { after }, mode);
        if (result.queued) {
            lib.tags.startPass();
        }

        response.send({ result: 'ok', refused: result.refused, queued: result.queued });
    } catch (err) {
        console.error('Could not reorder tag definitions', err);
        response.status(500).send({ error: 'Could not reorder tag definitions' });
    }
});

router.post('/unused-count', async (request, response) => {
    try {
        const count = await (await requestStore(request)).lib.tags.countUnused();
        response.send({ count });
    } catch (err) {
        console.error('Could not count unused tags', err);
        response.sendStatus(500);
    }
});

const PRUNE_MAX_LIMIT = 500;

router.post('/prune', async (request, response) => {
    try {
        const limit = Number(request.body?.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > PRUNE_MAX_LIMIT) {
            return response.status(400).send({ error: `limit must be an integer from 1 to ${PRUNE_MAX_LIMIT}` });
        }
        const deleted = await (await requestStore(request)).lib.tags.prune(limit);
        response.send({ deleted, more: deleted.length === limit });
    } catch (err) {
        console.error('Could not prune unused tags', err);
        response.sendStatus(500);
    }
});

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

        const result = await (await requestStore(request)).lib.tags.delete(id, mergeInto);

        response.send({ result: 'ok', refused: result.refused, mergedInto: result.mergedInto, target: result.target });
    } catch (err) {
        console.error('Could not delete tag definition', err);
        response.status(500).send({ error: 'Could not delete tag definition' });
    }
});

router.post('/backup', async (request, response) => {
    let definitions;
    let assignments;
    try {
        const { lib } = await requestStore(request);
        definitions = lib.tags.backupDefinitions();
        assignments = lib.tags.backupAssignments();
    } catch (err) {
        console.error('Could not start the tag backup', err);
        return response.sendStatus(500);
    }

    response.set('Content-Type', 'application/json');
    response.status(200);
    try {
        await writeBackpressured(response, '{"tags":[');
        let wroteAny = false;
        for await (const batch of definitions) {
            for (const tag of batch) {
                await writeBackpressured(response, (wroteAny ? ',' : '') + JSON.stringify(tag));
                wroteAny = true;
            }
        }
        await writeBackpressured(response, '],"tag_map":{');
        /** @type {{ key: string, tagIds: string[] } | null} */
        let pending = null;
        let wroteKey = false;
        const writeEntity = async (/** @type {{ key: string, tagIds: string[] }} */ entity) => {
            if (!entity.tagIds.length) return;
            await writeBackpressured(response, (wroteKey ? ',' : '') + JSON.stringify(entity.key) + ':' + JSON.stringify(entity.tagIds));
            wroteKey = true;
        };
        for await (const batch of assignments) {
            for (const entity of batch) {
                if (pending && pending.key === entity.key) {
                    for (const id of entity.tagIds) if (!pending.tagIds.includes(id)) pending.tagIds.push(id);
                    continue;
                }
                if (pending) await writeEntity(pending);
                pending = entity;
            }
        }
        if (pending) await writeEntity(pending);
        await writeBackpressured(response, '}}');
    } catch (err) {
        console.error('[tags/backup] Streaming response failed mid-flight; ending the connection:', err);
    }
    response.end();
});

const QUERY_REST_COUNT_MAX = 10000;

router.post('/query', async (request, response) => {
    try {
        const body = request.body ?? {};
        const filter = body.filter ?? {};
        const sortField = body.sort?.field ?? 'manual';
        if (!Object.hasOwn(TAG_SORTS, sortField)) {
            return response.status(400).send({ error: true, reason: 'invalid-sort-field' });
        }
        const parsed = parsePageRequest(body);
        if ('reason' in parsed) {
            return response.status(400).send({ error: true, ...parsed });
        }
        const { pageSize, cursor, ids, search, ifHash } = parsed.request;
        if (filter.name !== undefined && typeof filter.name !== 'string') {
            return response.status(400).send({ error: true, reason: 'invalid-name' });
        }
        if (filter.contains !== undefined && typeof filter.contains !== 'string') {
            return response.status(400).send({ error: true, reason: 'invalid-contains' });
        }
        if (body.counts !== undefined && typeof body.counts !== 'boolean') {
            return response.status(400).send({ error: true, reason: 'invalid-counts' });
        }
        if (body.restCount !== undefined && typeof body.restCount !== 'boolean') {
            return response.status(400).send({ error: true, reason: 'invalid-rest-count' });
        }
        for (const flag of ['used', 'folders']) {
            if (filter[flag] !== undefined && typeof filter[flag] !== 'boolean') {
                return response.status(400).send({ error: true, reason: `invalid-${flag}` });
            }
        }
        if (filter.folderType !== undefined && filter.folderType !== 'OPEN' && filter.folderType !== 'CLOSED') {
            return response.status(400).send({ error: true, reason: 'invalid-folder-type', message: 'filter.folderType takes "OPEN" or "CLOSED".' });
        }
        const params = {
            sort: sortField,
            search,
            name: filter.name,
            contains: filter.contains?.trim() || undefined,
            counts: body.counts === true,
            ids,
            used: filter.used === true,
            folders: filter.folders === true || filter.folderType !== undefined,
            folderType: filter.folderType,
            pageSize,
            cursor,
        };
        const { lib } = await requestStore(request);
        let result = await lib.tags.query(params);
        if (result === 'invalid-cursor') {
            return response.status(400).send({ error: true, reason: 'invalid-cursor' });
        }
        if (body.restCount === true && !ids && result.cursor && !result.more && result.rows.length === pageSize) {
            const rest = await lib.tags.query({ ...params, counts: false, pageSize: QUERY_REST_COUNT_MAX, cursor: result.cursor });
            if (rest !== 'invalid-cursor') {
                result = { ...result, rest: { count: rest.rows.length, more: rest.cursor !== null } };
            }
        }
        response.send(pageAnswer(result, ifHash));
    } catch (err) {
        console.error('Could not query tag definitions', err);
        response.status(500).send({ error: true });
    }
});

const BY_IDS_MAX_IDS = 500;

router.post('/by-ids', async (request, response) => {
    try {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids : [];
        if (new Set(ids.map(String)).size > BY_IDS_MAX_IDS) {
            return response.status(400).send({ error: `at most ${BY_IDS_MAX_IDS} distinct ids per request` });
        }
        const known = request.body?.known;
        if (known !== undefined && (known === null || typeof known !== 'object' || Array.isArray(known))) {
            return response.status(400).send({ error: 'known must be an object of id to hash' });
        }
        response.send(await (await requestStore(request)).lib.tags.byIds(ids, known));
    } catch (err) {
        console.error('Could not read tag definitions by id', err);
        response.sendStatus(500);
    }
});

const BY_NAMES_MAX_NAMES = 100;

router.post('/by-names', async (request, response) => {
    try {
        const names = request.body?.names;
        if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) {
            return response.status(400).send({ error: 'names must be an array of strings' });
        }
        if (new Set(names).size > BY_NAMES_MAX_NAMES) {
            return response.status(400).send({ error: `at most ${BY_NAMES_MAX_NAMES} distinct names per request` });
        }
        const found = await (await requestStore(request)).lib.tags.findByNames(names);
        response.send({ tags: found });
    } catch (err) {
        console.error('Could not look up tags by name', err);
        response.sendStatus(500);
    }
});

router.post('/manifest', async (request, response) => {
    try {
        const { lib } = await requestStore(request);
        const changesSeq = await lib.tags.changesSeq();
        const assignmentChanges = await lib.tags.entityChangesEnd();
        response.send({ changesSeq, assignmentChanges });
    } catch (err) {
        console.error('Could not read the tag change cursors', err);
        response.sendStatus(500);
    }
});

const TAG_CHANGES_PAGE_SIZE = 500;

router.post('/changes', async (request, response) => {
    try {
        const page = await (await requestStore(request)).lib.tags.changes(request.body?.sinceSeq, { limit: TAG_CHANGES_PAGE_SIZE });
        response.send(page);
    } catch (err) {
        console.error('Could not read tag changes', err);
        response.sendStatus(500);
    }
});

router.post('/assignment-changes', async (request, response) => {
    try {
        const { sinceSeq, sinceGroupsVersion } = request.body ?? {};
        const page = await (await requestStore(request)).lib.tags.entityChanges({ sinceSeq, sinceGroupsVersion }, { limit: TAG_CHANGES_PAGE_SIZE });
        response.send(page);
    } catch (err) {
        console.error('Could not read tag assignment changes', err);
        response.sendStatus(500);
    }
});

const FOR_MAX_IDS = 500;

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

        const result = await (await requestStore(request)).lib.tags.tagIdsFor(uniqueIds);

        response.send(result);
    } catch (err) {
        console.error('Could not resolve tags for entities', err);
        response.sendStatus(500);
    }
});

router.post('/assign', async (request, response) => {
    try {
        const { id, tagId } = request.body;
        if (typeof id !== 'string' || !id || typeof tagId !== 'string' || !tagId) {
            return response.status(400).send({ error: 'id and tagId are required non-empty strings' });
        }

        const answer = await (await requestStore(request)).lib.tags.assign(id, tagId);
        if (answer.result === 'not_found') {
            return response.status(404).send({ error: 'Character or group not found' });
        }

        response.send({ result: 'ok', assigned: answer.assigned, reason: answer.reason, defined: answer.defined });
    } catch (err) {
        console.error('Could not assign tag', err);
        response.sendStatus(500);
    }
});

router.post('/unassign', async (request, response) => {
    try {
        const { id, tagId } = request.body;
        if (typeof id !== 'string' || !id || typeof tagId !== 'string' || !tagId) {
            return response.status(400).send({ error: 'id and tagId are required non-empty strings' });
        }

        const answer = await (await requestStore(request)).lib.tags.unassign(id, tagId);

        response.send(answer === 'deleted' ? { result: 'ok', refused: [{ id: tagId, reason: 'deleted' }] } : { result: 'ok' });
    } catch (err) {
        console.error('Could not unassign tag', err);
        response.sendStatus(500);
    }
});

router.post('/copy', async (request, response) => {
    try {
        const { from, to } = request.body ?? {};
        if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) {
            return response.status(400).send({ error: 'from and to are required non-empty strings' });
        }

        const result = await (await requestStore(request)).lib.tags.copy(from, to);
        if (result === 'not_found') {
            return response.status(404).send({ error: 'Character or group not found' });
        }

        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not copy tags', err);
        response.sendStatus(500);
    }
});

router.post('/rename-key', async (request, response) => {
    try {
        const { from, to } = request.body ?? {};
        if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) {
            return response.status(400).send({ error: 'from and to are required non-empty strings' });
        }

        const answer = await (await requestStore(request)).lib.tags.move(from, to);
        if (answer.result === 'not_found') {
            return response.status(404).send({ error: 'Character or group not found' });
        }

        response.send(answer);
    } catch (err) {
        console.error('Could not move tags', err);
        response.sendStatus(500);
    }
});

router.post('/restore', async (request, response) => {
    try {
        const { tags, tagMap, overwrite } = request.body ?? {};
        if (!Array.isArray(tags)) {
            return response.status(400).send({ error: 'tags must be an array' });
        }
        if (typeof tagMap !== 'object' || tagMap === null || Array.isArray(tagMap)) {
            return response.status(400).send({ error: 'tagMap must be an object' });
        }
        if (typeof overwrite !== 'boolean') {
            return response.status(400).send({ error: 'overwrite must be a boolean' });
        }

        const result = await (await requestStore(request)).lib.tags.restore({ tags, tagMap, overwrite });

        response.send(result);
    } catch (err) {
        console.error('Could not restore the tag backup', err);
        response.sendStatus(500);
    }
});

