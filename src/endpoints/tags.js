import crypto from 'node:crypto';

import express from 'express';

import {
    assignEntityTagReporting,
    unassignEntityTag,
    copyEntityTags,
    moveEntityTags,
    restoreTagBackup,
    getEntityTagIdsForMany,
    streamTagDefinitionBatches,
    streamEntityTagAssignmentBatches,
    createTagDefinition,
    editTagDefinition,
    moveTagDefinition,
    reorderTagDefinitions,
    deleteTagDefinition,
    countUnusedTags,
    pruneUnusedTags,
    getTagsHash,
    getTagChangesSince,
    getTagChangesSeq,
    getEntityTagChangesSince,
    getEntityTagChangesEnd,
    getTagsDigest,
    getTagsBucketMembers,
    getTagDefinitionsByIds,
    getGoneTagIds,
    findTagsByNames,
    queryTags,
    decodeTagQueryCursor,
    TAG_QUERY_SORTS,
    TAG_REORDER_MODES,
} from '../character-metadata-db.js';
import { requestMetadataMigrationPass } from '../metadata-migration-coordinator.js';
import { writeBackpressured } from '../util.js';
import { contentHashOf } from '../../public/scripts/hash-utils.js';

export const router = express.Router();

/**
 * `{ tag, freeName }` → `{ result, refused: [{ id, reason: 'deleted' | 'exists' }], tag }`. `tag` is the definition
 * as stored, when it was; a tag sent with no `sort_order` gets the next place in the manual order. With
 * `freeName: true`, `tag.name` is only a base and the server picks a name no other tag has (`name`, else `name #1`,
 * `name #2`, ...); 503 with reason 'tag-names-not-indexed', and nothing written, until tag names can be looked up.
 */
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

        const result = await createTagDefinition(request.user.directories, tag, { freeName: freeName === true });
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (result === 'names-not-ready') {
            return response.status(503).send({ error: 'Tag names are still being indexed', reason: 'tag-names-not-indexed' });
        }

        response.send({ result: 'ok', refused: result.refused, tag: result.tag });
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
 * 'unreadable' | 'unordered' | 'no-room' }], written: [{ id, sort_order }], queued }`. Puts tag `id` right before or
 * after the anchor tag (by id) in the manual order. written: every tag the move wrote, with the sort_order now
 * stored. queued: the move arrived before the tag sort_order fill finished or while a reorder pass is recorded, and
 * is applied when that pass ends (moveTagDefinition()); the changes stream says when ('tag-order-settled').
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

        response.send({ result: 'ok', refused: result.refused, written: result.written, queued: result.queued === true });
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
 * `{ id, mergeInto? }` → `{ result, refused: [{ id, reason: 'deleted' | 'missing' | 'same' | 'unreadable' }],
 * mergedInto, target }`. Deletes one tag definition by id. `mergeInto`, when given, is the tag every entity carrying
 * the deleted one gets instead, as upstream's delete-and-merge does. refused: nothing was deleted; each entry names
 * the tag its reason is about, `id` or `mergeInto`. mergedInto: the tag the entities got, which is not `mergeInto`
 * when that one had itself been merged into another; null with no merge. target: mergedInto's definition.
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
        if (!result.refused.length) {
            // Not awaited: the pass moves the deleted tag's rows onto its merge target in a worker, after this responds.
            requestMetadataMigrationPass(request.user.directories, 'finishDeletedTags')
                .catch(err => console.error('Could not run the deleted tag finishing pass', err));
        }

        response.send({ result: 'ok', refused: result.refused, mergedInto: result.mergedInto, target: result.target });
    } catch (err) {
        console.error('Could not delete tag definition', err);
        response.status(500).send({ error: 'Could not delete tag definition' });
    }
});

router.post('/get', async (request, response) => {
    let batches;
    let first;
    try {
        batches = await streamTagDefinitionBatches(request.user.directories);
        if (batches === null) {
            return response.send({ tags: null });
        }
        // Read before the first write, so a failure here can still answer 500.
        first = await batches.next();
    } catch (err) {
        console.error('Could not read tag definitions', err);
        return response.sendStatus(500);
    }

    // Past the first write, a failure can't un-send the 200 and partial body, so it logs and ends the connection.
    response.set('Content-Type', 'application/json');
    response.status(200);
    try {
        await writeBackpressured(response, '{"tags":[');
        let wroteAny = false;
        for (let next = first; !next.done; next = await batches.next()) {
            for (const tag of next.value) {
                await writeBackpressured(response, (wroteAny ? ',' : '') + JSON.stringify(tag));
                wroteAny = true;
            }
        }
        await writeBackpressured(response, ']}');
    } catch (err) {
        console.error('[tags/get] Streaming response failed mid-flight; ending the connection:', err);
    }
    response.end();
});

/**
 * The tag backup file: `{ tags: [...every tag definition], tag_map: { key: [tag ids] } }`, streamed. Every character
 * and group the store has is in it, whatever any page holds. A tag being deleted is left out of `tags`, and an
 * assignment of it reads as its merge target.
 */
router.post('/backup', async (request, response) => {
    let definitions;
    let assignments;
    try {
        definitions = await streamTagDefinitionBatches(request.user.directories);
        assignments = await streamEntityTagAssignmentBatches(request.user.directories);
        if (definitions === null || assignments === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
    } catch (err) {
        console.error('Could not start the tag backup', err);
        return response.sendStatus(500);
    }

    // Past the first write, a failure can't un-send the 200 and partial body, so it logs and ends the connection
    // without the closing brackets: the file then doesn't parse, and a restore refuses it.
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
/** `restCount` counts at most this many tags after a page; past it the answer says "at least". */
const QUERY_REST_COUNT_MAX = 10000;

/**
 * One page of tag definitions:
 * `{ filter: { search, name, contains, ids, used, folders }, sort: { field }, pageSize, cursor, counts, ifHash, restCount }`
 * → `{ rows, cursor, more }`. `search` is a prefix of the name and `contains` text anywhere in it, both ignoring case
 * and accents. With `counts: true` the answer also has `counts: { [id]: n }`, how many characters and groups carry
 * each row's tag, and `approximate`, the ids whose count may be too high while a merge is unfinished.
 * `sort.field` is a tag_sort_mode value, manual by default. `cursor` is the one a
 * previous page returned, for the same sort; a manual one is refused (400 invalid-cursor) once the manual order it
 * was made in is no longer the one read, i.e. when a tag reorder pass starts or starts draining. `more` means the server's work cap cut the page short and `cursor`
 * carries on; otherwise a null `cursor` is the end.
 *
 * With `ifHash` (a string, empty when the client holds no copy of this page) the answer also has `hash`, and is
 * only `{ unchanged: true, hash }` when `ifHash` is the hash of what would be answered now.
 *
 * With `restCount: true`, a full page that has a next page also answers `rest: { count, more }`: how many tags
 * match after it, counted up to QUERY_REST_COUNT_MAX under the same work cap. `more` means there may be more than
 * `count`. A page cut short by the work cap (`more`) or with no next page has no `rest`.
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
        if (filter.contains !== undefined && typeof filter.contains !== 'string') {
            return response.status(400).send({ error: true, reason: 'invalid-contains' });
        }
        if (body.counts !== undefined && typeof body.counts !== 'boolean') {
            return response.status(400).send({ error: true, reason: 'invalid-counts' });
        }
        if (body.ifHash !== undefined && typeof body.ifHash !== 'string') {
            return response.status(400).send({ error: true, reason: 'invalid-if-hash' });
        }
        if (body.restCount !== undefined && typeof body.restCount !== 'boolean') {
            return response.status(400).send({ error: true, reason: 'invalid-rest-count' });
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

        const params = {
            sort: sortField,
            search: filter.search?.trim() || undefined,
            name: filter.name,
            contains: filter.contains?.trim() || undefined,
            counts: body.counts === true,
            ids,
            used: filter.used === true,
            folders: filter.folders === true,
            pageSize,
            after,
        };
        let result = await queryTags(request.user.directories, params);
        if (result === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        if (result === 'invalid-cursor') {
            return response.status(400).send({ error: true, reason: 'invalid-cursor' });
        }
        if (body.restCount === true && !ids && result.cursor && !result.more && result.rows.length === pageSize) {
            const restAfter = decodeTagQueryCursor(result.cursor, sortField);
            const rest = restAfter === null ? null : await queryTags(request.user.directories,
                { ...params, counts: false, pageSize: QUERY_REST_COUNT_MAX, after: restAfter });
            if (rest && rest !== 'invalid-cursor') {
                result = { ...result, rest: { count: rest.rows.length, more: rest.cursor !== null } };
            }
        }
        if (body.ifHash !== undefined) {
            const hash = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
            return response.send(hash === body.ifHash ? { unchanged: true, hash } : { ...result, hash });
        }
        response.send(result);
    } catch (err) {
        console.error('Could not query tag definitions', err);
        response.status(500).send({ error: true });
    }
});

const BY_IDS_MAX_IDS = 500;

/**
 * `{ ids, known }` → `{ tags, gone, unchanged }`: the definitions for a named set of ids, and the ids among them no
 * tag has (never stored, deleted, or marked deleted). `known` (optional) maps an id to contentHashOf() of the copy
 * the caller holds: a definition with that hash is left out of `tags` and listed in `unchanged`. An id in none of
 * the three is a tag whose stored definition can't be read. More than BY_IDS_MAX_IDS distinct ids is a 400 rather
 * than a truncated answer, which would read as those tags not existing.
 */
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
        const tags = await getTagDefinitionsByIds(request.user.directories, ids);
        const gone = tags === null ? null : await getGoneTagIds(request.user.directories, ids);
        if (tags === null || gone === null) {
            return response.send({ tags: null });
        }
        if (!known) {
            return response.send({ tags, gone });
        }
        /** @type {string[]} */
        const unchanged = [];
        const changed = tags.filter((tag) => {
            if (!Object.hasOwn(known, tag.id) || known[tag.id] !== contentHashOf(tag)) return true;
            unchanged.push(tag.id);
            return false;
        });
        response.send({ tags: changed, gone, unchanged });
    } catch (err) {
        console.error('Could not read tag definitions by id', err);
        response.sendStatus(500);
    }
});

const BY_NAMES_MAX_NAMES = 100;

/**
 * `{ names }` → `{ tags: [{ name, tag }] }`, one entry per distinct name in the order given: the tag each name stands
 * for (findTagsByNames()), or null. 503 with reason 'tag-names-not-indexed' until tag names can be looked up.
 */
router.post('/by-names', async (request, response) => {
    try {
        const names = request.body?.names;
        if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) {
            return response.status(400).send({ error: 'names must be an array of strings' });
        }
        if (new Set(names).size > BY_NAMES_MAX_NAMES) {
            return response.status(400).send({ error: `at most ${BY_NAMES_MAX_NAMES} distinct names per request` });
        }
        const found = await findTagsByNames(request.user.directories, names);
        if (found === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (found === 'names-not-ready') {
            return response.status(503).send({ error: 'Tag names are still being indexed', reason: 'tag-names-not-indexed' });
        }
        response.send({ tags: found });
    } catch (err) {
        console.error('Could not look up tags by name', err);
        response.sendStatus(500);
    }
});

/**
 * Freshness check for the client's tags cache; only changes when definitions change, not assignments. `changesSeq`
 * is where the tag change log ends at the definitions `hash` covers: the cursor to give /changes next.
 * `assignmentChanges` is `{ seq, groupsVersion }`, the cursors to give /assignment-changes next by a client that
 * reads its characters and groups after this answer; null when the store is unavailable.
 */
router.post('/manifest', async (request, response) => {
    try {
        const hash = await getTagsHash(request.user.directories);
        const changesSeq = await getTagChangesSeq(request.user.directories);
        const assignmentChanges = await getEntityTagChangesEnd(request.user.directories);
        response.send({ hash, changesSeq, assignmentChanges });
    } catch (err) {
        console.error('Could not get tags revision', err);
        response.sendStatus(500);
    }
});

const TAG_CHANGES_PAGE_SIZE = 500;

/**
 * `{ sinceSeq }` → one page of what changed in the tag definitions past that cursor:
 * `{ seq, reset, tags, removed: [{ id, mergedInto }], hasMore }` (TagChangesPage). At most TAG_CHANGES_PAGE_SIZE log
 * rows per answer. `reset` tells the client to re-read the tags it holds instead; a missing or unusable `sinceSeq`
 * always answers that, with the cursor to go on from.
 */
router.post('/changes', async (request, response) => {
    try {
        const page = await getTagChangesSince(request.user.directories, request.body?.sinceSeq, { limit: TAG_CHANGES_PAGE_SIZE });
        if (page === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        response.send(page);
    } catch (err) {
        console.error('Could not read tag changes', err);
        response.sendStatus(500);
    }
});

/**
 * `{ sinceSeq, sinceGroupsVersion }` → one page of which characters and groups may have had their tags changed past
 * those cursors: `{ seq, groupsVersion, endSeq, endGroupsVersion, reset, ids, hasMore }` (EntityTagChangesPage). At
 * most TAG_CHANGES_PAGE_SIZE log rows per answer. The client reads the tags of the listed entities it holds with
 * /for. `reset` tells it to re-read the tags of everything it holds instead; missing or unusable cursors always
 * answer that, with the cursors to go on from.
 */
router.post('/assignment-changes', async (request, response) => {
    try {
        const { sinceSeq, sinceGroupsVersion } = request.body ?? {};
        const page = await getEntityTagChangesSince(request.user.directories, { sinceSeq, sinceGroupsVersion }, { limit: TAG_CHANGES_PAGE_SIZE });
        if (page === null) {
            return response.status(503).send({ error: true, reason: 'metadata-store-unavailable' });
        }
        response.send(page);
    } catch (err) {
        console.error('Could not read tag assignment changes', err);
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

/**
 * `{ id, tagId }` → `{ result: 'ok', assigned, reason, defined }`. `assigned` is the tag the entity got: `tagId`
 * (reason null); or the tag `tagId` was merged into, when it is being deleted with a merge target ('merged'); or
 * null, and nothing was assigned, when it is being deleted with no merge target ('deleted'). `defined` is false
 * when no stored tag has the assigned id: the assignment is stored, and shows nowhere until a tag has that id.
 */
router.post('/assign', async (request, response) => {
    try {
        const { id, tagId } = request.body;
        if (typeof id !== 'string' || !id || typeof tagId !== 'string' || !tagId) {
            return response.status(400).send({ error: 'id and tagId are required non-empty strings' });
        }

        const answer = await assignEntityTagReporting(request.user.directories, id, tagId);
        if (answer === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (answer.result === 'not_found') {
            return response.status(404).send({ error: 'Character or group not found' });
        }

        response.send({ result: 'ok', assigned: answer.assigned, reason: answer.reason, defined: answer.defined });
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

/** `{ from, to }` (character avatars or group ids): adds the tags `from` has to what `to` has. */
router.post('/copy', async (request, response) => {
    try {
        const { from, to } = request.body ?? {};
        if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) {
            return response.status(400).send({ error: 'from and to are required non-empty strings' });
        }

        const result = await copyEntityTags(request.user.directories, from, to);
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (result === 'not_found') {
            return response.status(404).send({ error: 'Character or group not found' });
        }

        response.send({ result: 'ok' });
    } catch (err) {
        console.error('Could not copy tags', err);
        response.sendStatus(500);
    }
});

/**
 * `{ from, to }` → `{ result: 'ok', moved }`: the tags of `from` are added to what `to` has and taken off
 * `from`. `moved` lists the tag ids taken off. 404, and nothing written, if `from` has tags and `to` is not a
 * character or group.
 */
router.post('/rename-key', async (request, response) => {
    try {
        const { from, to } = request.body ?? {};
        if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) {
            return response.status(400).send({ error: 'from and to are required non-empty strings' });
        }

        const answer = await moveEntityTags(request.user.directories, from, to);
        if (answer === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (answer.result === 'not_found') {
            return response.status(404).send({ error: 'Character or group not found' });
        }

        response.send(answer);
    } catch (err) {
        console.error('Could not move tags', err);
        response.sendStatus(500);
    }
});

/**
 * `{ tags, tagMap, overwrite }` (a tag backup's `tags` and `tag_map`, and whether the backup's settings replace
 * those of tags that already exist) → everything restoreTagBackup() did not restore, plus `createdTagIds` and
 * `updatedTagIds`. 503 with reason 'tag-names-not-indexed', and nothing written, until tag names can be looked up.
 */
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

        const result = await restoreTagBackup(request.user.directories, { tags, tagMap, overwrite });
        if (result === null) {
            return response.status(503).send({ error: 'Character metadata store is unavailable' });
        }
        if (result === 'names-not-ready') {
            return response.status(503).send({ error: 'Tag names are still being indexed', reason: 'tag-names-not-indexed' });
        }

        response.send(result);
    } catch (err) {
        console.error('Could not restore the tag backup', err);
        response.sendStatus(500);
    }
});

