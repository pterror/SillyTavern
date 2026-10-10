import crypto from 'node:crypto';

import { tagEntityTypeOf } from './group-id.js';
import { FIELD, TAG_KEY_PREFIX, TYPE } from './library-codes.js';
import { contentHashOf, normalizeTagIds } from '../public/scripts/hash-utils.js';

/**
 * The tag manager on the engine: tag definitions, assignments and their change feeds, answered in the shapes the
 * old store's functions give `src/endpoints/tags.js`.
 */

/** The sorts of a tag page, by the client's tag_sort_mode values. */
export const TAG_SORTS = Object.freeze({ alphabetical: 0, by_entries: 1, manual: 2 });

/** How many numbered names freeName() tries before it stops looking. */
const FREE_NAME_TRIES = 20000;
/** Names freeName() looks up per read. */
const FREE_NAME_BATCH = 100;
/** Definitions per batch of the backup's stream. */
const BACKUP_BATCH = 1000;

/**
 * A stored tag's definition: its key as `id`, its name, its folder type and every other key it was stored with.
 * @param {import('./library-engine.js').StoredEntity} entity
 * @returns {Record<string, unknown>}
 */
export function tagDefinition(entity) {
    /** @type {Record<string, unknown>} */
    const tag = { id: entity.key };
    // A key such as `__proto__` is set as the tag's own property, as JSON.parse() gave it.
    const set = (/** @type {string} */ key, /** @type {unknown} */ value) => Object.defineProperty(tag, key, { value, enumerable: true, writable: true, configurable: true });
    for (const v of entity.values) {
        const value = () => (v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json)));
        if (v.field === FIELD.name) set('name', value());
        else if (v.field === FIELD.folder_type) set('folder_type', value());
        else if (typeof v.field === 'string' && v.field.startsWith(TAG_KEY_PREFIX)) set(v.field.slice(TAG_KEY_PREFIX.length), value());
    }
    return tag;
}

/**
 * @typedef {{ id: bigint, state: 'live' | 'undefined' | 'gone', into?: string }} TagStatus
 * @typedef {{ id: string, reason: string }} TagRefusal
 */

export class LibraryTags {
    /**
     * @param {import('./library-engine.js').LibraryEngine} lib
     */
    constructor(lib) {
        this.lib = lib;
        this.store = lib.store;
    }

    /**
     * Runs `write` after every earlier definition write, so what it reads (free names, the next sort order) stays
     * true until it has written.
     * @template T
     * @param {() => Promise<T>} write
     * @returns {Promise<T>}
     */
    lane(write) {
        return this.lib.serialized(TYPE.tag, '', write);
    }

    /**
     * @param {string[]} keys
     * @returns {Promise<(TagStatus | null)[]>}
     */
    status(keys) {
        return keys.length > 0 ? this.store.tagStatus(keys) : Promise.resolve([]);
    }

    /**
     * The definitions of tag entities, in the order given; null where there is none.
     * @param {bigint[]} ids
     * @returns {Promise<(Record<string, unknown> | null)[]>}
     */
    async definitions(ids) {
        return (await this.lib.entities(ids)).map(e => (e && e.type === TYPE.tag ? tagDefinition(e) : null));
    }

    /**
     * The next manual sort order, upstream's newTag(): one past the highest, and at least 1.
     */
    async nextOrder() {
        return Math.max(0, (await this.store.tagMaxOrder()) ?? 0) + 1;
    }

    /**
     * A name no live tag has, made from `base` as the page's getFreeName() makes one: `base` itself, else the first
     * free of `base #1`, `base #2`, ... (names compared folded). Past FREE_NAME_TRIES it is `base #<a new uuid>`.
     * @param {string} base
     */
    async freeName(base) {
        if ((await this.store.tagByNames([base]))[0] === null) return base;
        for (let n = 1; n <= FREE_NAME_TRIES; n += FREE_NAME_BATCH) {
            const names = Array.from({ length: Math.min(FREE_NAME_BATCH, FREE_NAME_TRIES - n + 1) }, (_, i) => `${base} #${n + i}`);
            const found = await this.store.tagByNames(names);
            const free = found.findIndex((/** @type {bigint | null} */ t) => t === null);
            if (free !== -1) return names[free];
        }
        return `${base} #${crypto.randomUUID()}`;
    }

    /**
     * createTagDefinition(): refused `deleted` for a deleted tag's id and `exists` for a defined one; a key only
     * assignments named gets its definition. A tag with no own sort_order gets nextOrder().
     * @param {unknown} rawTag
     * @param {{ freeName?: boolean }} [options] The given name is only a base: the tag gets freeName()'s.
     * @returns {Promise<{ refused: TagRefusal[], tag?: Record<string, unknown> } | null>} null when `rawTag` isn't a
     *   tag with a non-empty string id.
     */
    create(rawTag, { freeName = false } = {}) {
        const given = /** @type {Record<string, unknown> | null} */ (rawTag);
        if (!given || typeof given !== 'object' || typeof given.id !== 'string' || !given.id) return Promise.resolve(null);
        const id = given.id;
        return this.lane(async () => {
            const [status] = await this.status([id]);
            if (status?.state === 'gone') return { refused: [{ id, reason: 'deleted' }] };
            if (status?.state === 'live') return { refused: [{ id, reason: 'exists' }] };
            const tag = { ...given };
            if (freeName) tag.name = await this.freeName(typeof given.name === 'string' ? given.name : '');
            if (!Object.hasOwn(tag, 'sort_order')) tag.sort_order = await this.nextOrder();
            await this.lib.writeTag(/** @type {any} */ (tag));
            return { refused: [], tag };
        });
    }

    /**
     * editTagDefinition(): the patch over the stored definition, written only when that changes it.
     * @param {string} id
     * @param {Record<string, unknown>} patch
     * @returns {Promise<{ refused: TagRefusal[] }>}
     */
    edit(id, patch) {
        return this.lane(async () => {
            const [status] = await this.status([id]);
            if (status?.state === 'gone') return { refused: [{ id, reason: 'deleted' }] };
            if (status?.state !== 'live') return { refused: [{ id, reason: 'missing' }] };
            const [old] = await this.definitions([status.id]);
            const merged = { ...old, ...patch, id };
            if (JSON.stringify(merged) !== JSON.stringify(old)) await this.lib.writeTag(/** @type {any} */ (merged));
            return { refused: [] };
        });
    }

    /**
     * deleteTagDefinition(): the tag goes, its carriers becoming those of `mergeInto` (followed through its own
     * merges) or carrying nothing.
     * @param {string} id
     * @param {string | null} [mergeInto]
     * @returns {Promise<{ refused: TagRefusal[], mergedInto: string | null, target: Record<string, unknown> | null }>}
     */
    delete(id, mergeInto = null) {
        return this.lane(async () => {
            /** @param {string} tag @param {string} reason */
            const refuse = (tag, reason) => ({ refused: [{ id: tag, reason }], mergedInto: null, target: null });
            const [status] = await this.status([id]);
            if (status?.state === 'gone') return refuse(id, 'deleted');
            if (status?.state !== 'live') return refuse(id, 'missing');
            /** @type {string | null} */
            let target = null;
            /** @type {Record<string, unknown> | null} */
            let definition = null;
            if (typeof mergeInto === 'string' && mergeInto) {
                if (mergeInto === id) return refuse(mergeInto, 'same');
                const [into] = await this.status([mergeInto]);
                if (into?.state === 'gone' && into.into === undefined) return refuse(mergeInto, 'deleted');
                target = into?.state === 'gone' ? /** @type {string} */ (into.into) : mergeInto;
                const [targetStatus] = into?.state === 'gone' ? await this.status([target]) : [into];
                if (targetStatus?.state !== 'live') return refuse(mergeInto, 'missing');
                [definition] = await this.definitions([targetStatus.id]);
            }
            await this.lib.deleteTag(id, target);
            return { refused: [], mergedInto: target, target: definition };
        });
    }

    /** countUnusedTags(). */
    async countUnused() {
        return Number((await this.store.tagUnused(1)).count);
    }

    /**
     * pruneUnusedTags(): deletes up to `limit` tags nothing carries. A tag assigned meanwhile is kept.
     * @param {number} limit
     * @returns {Promise<string[]>} The deleted tags' ids.
     */
    prune(limit) {
        return this.lane(async () => {
            const { ids } = await this.store.tagUnused(limit);
            if (ids.length === 0) return [];
            await this.store.commit(ids.map((/** @type {bigint} */ tag) => ({ kind: 'tagPrune', tag })));
            const keys = await this.store.tagKeys(ids);
            return keys.filter((/** @type {any} */ k) => k?.state === 'gone').map((/** @type {any} */ k) => k.key);
        });
    }

    /**
     * queryTags(): one page of definitions in a sort's order under the filters.
     * @param {object} params
     * @param {keyof typeof TAG_SORTS} params.sort
     * @param {string} [params.search] A prefix of the name, both folded.
     * @param {string} [params.name] The whole name, both folded.
     * @param {string} [params.contains] Text the folded name holds.
     * @param {boolean} [params.counts]
     * @param {string[]} [params.ids]
     * @param {boolean} [params.used]
     * @param {boolean} [params.folders]
     * @param {string} [params.folderType]
     * @param {number} params.pageSize
     * @param {string | null} [params.cursor] One this read returned for the same sort.
     * @returns {Promise<{ rows: object[], cursor: string | null, more: boolean, counts?: Record<string, number>, approximate?: string[] } | 'invalid-cursor'>}
     */
    async query(params) {
        const sort = TAG_SORTS[params.sort];
        /** @type {Record<string, unknown>} */
        const q = { sort, limit: params.pageSize };
        if (params.used) q.used = true;
        if (params.folders) q.folders = true;
        for (const key of /** @type {const} */ (['folderType', 'search', 'name', 'contains'])) {
            if (typeof params[key] === 'string') q[key] = params[key];
        }
        if (params.ids) {
            const statuses = await this.status([...new Set(params.ids)]);
            q.ids = statuses.filter(s => s?.state === 'live').map(s => /** @type {TagStatus} */ (s).id);
        }
        if (typeof params.cursor === 'string') {
            const after = Buffer.from(params.cursor, 'base64url');
            if (after.length === 0 || after[0] !== sort) return 'invalid-cursor';
            q.after = after;
        }
        let page;
        try {
            page = await this.store.tagPage(q);
        } catch (err) {
            if (/** @type {Error} */ (err).message === 'invalid-cursor') return 'invalid-cursor';
            throw err;
        }
        const rows = /** @type {Record<string, unknown>[]} */ ((await this.definitions(page.ids)).filter(d => d !== null));
        const result = { rows, cursor: page.cursor ? page.cursor.toString('base64url') : null, more: page.more };
        if (!params.counts) return result;
        return { ...result, ...(await this.counts(page.ids, rows.map(r => /** @type {string} */ (r.id)))) };
    }

    /**
     * How many characters and groups carry each tag, with the carriers of tags merged into it that haven't moved
     * yet; `approximate` lists the tags whose count may count an entity twice meanwhile.
     * @param {bigint[]} ids
     * @param {string[]} keys
     */
    async counts(ids, keys) {
        const found = ids.length > 0 ? await this.store.tagCounts(ids) : [];
        /** @type {Record<string, number>} */
        const counts = {};
        /** @type {string[]} */
        const approximate = [];
        found.forEach((/** @type {{ count: number, approximate: boolean }} */ c, /** @type {number} */ i) => {
            counts[keys[i]] = Number(c.count);
            if (c.approximate) approximate.push(keys[i]);
        });
        return { counts, approximate };
    }

    /**
     * `/by-ids`: the definitions of the live tags among `ids`; `gone`, the ids no live tag has; `merged`, each
     * deleted id whose merges lead to a live tag, mapped to it (its definition in `tags` too). With `known` (id →
     * contentHashOf() of the caller's copy), a definition with that hash is listed in `unchanged` instead.
     * @param {unknown[]} ids
     * @param {Record<string, string>} [known]
     */
    async byIds(ids, known) {
        const asked = [...new Set(ids.map(String))];
        const statuses = await this.status(asked);
        /** @type {Record<string, string>} */
        const merged = {};
        /** @type {string[]} */
        const gone = [];
        /** @type {bigint[]} */
        const live = [];
        statuses.forEach((s, i) => {
            if (s?.state === 'live') live.push(s.id);
            else if (s?.state === 'gone' && s.into !== undefined) merged[asked[i]] = s.into;
            else gone.push(asked[i]);
        });
        const askedSet = new Set(asked);
        const targets = [...new Set(Object.values(merged))].filter(k => !askedSet.has(k));
        for (const s of await this.status(targets)) if (s?.state === 'live') live.push(s.id);
        const tags = /** @type {Record<string, unknown>[]} */ ((await this.definitions(live)).filter(d => d !== null));
        if (!known) return { tags, gone, merged };
        /** @type {string[]} */
        const unchanged = [];
        const changed = tags.filter((tag) => {
            const id = /** @type {string} */ (tag.id);
            if (!Object.hasOwn(known, id) || known[id] !== contentHashOf(tag)) return true;
            unchanged.push(id);
            return false;
        });
        return { tags: changed, gone, merged, unchanged };
    }

    /**
     * findTagsByNames(): per distinct name, in the order given, the live tag it stands for (names compared folded,
     * the first created of several), or null.
     * @param {string[]} names
     * @returns {Promise<{ name: string, tag: Record<string, unknown> | null }[]>}
     */
    async findByNames(names) {
        const distinct = [...new Set(names)];
        const found = distinct.length > 0 ? await this.store.tagByNames(distinct) : [];
        const definitions = await this.definitions(found.filter((/** @type {bigint | null} */ t) => t !== null));
        let next = 0;
        return distinct.map((name, i) => ({ name, tag: found[i] === null ? null : definitions[next++] }));
    }

    /**
     * `/changes` (getTagChangesSince()): the tags whose definitions changed past `sinceSeq`, at most `limit`, each as
     * it is now: live ones in `tags`, deleted ones in `removed` with the live tag their merges lead to.
     * @param {unknown} sinceSeq Anything but a non-negative integer, or one past the feed's end, answers `reset`.
     * @param {{ limit: number }} options
     */
    async changes(sinceSeq, { limit }) {
        const usable = typeof sinceSeq === 'number' && Number.isSafeInteger(sinceSeq) && sinceSeq >= 0;
        const feed = await this.store.tagFeed('tags', BigInt(usable ? sinceSeq : 0), usable ? limit : 0);
        const end = Number(feed.end);
        if (!usable || /** @type {number} */ (sinceSeq) > end) return { seq: end, reset: true, tags: [], removed: [], hasMore: false };
        const entries = /** @type {{ pos: bigint, id: bigint }[]} */ (feed.entries);
        const keys = await this.store.tagKeys(entries.map(e => e.id));
        /** @type {bigint[]} */
        const live = [];
        /** @type {{ id: string, mergedInto: string | null }[]} */
        const removed = [];
        keys.forEach((/** @type {any} */ k, /** @type {number} */ i) => {
            if (k?.state === 'live') live.push(entries[i].id);
            else if (k) removed.push({ id: k.key, mergedInto: k.into ?? null });
        });
        const tags = (await this.definitions(live)).filter(d => d !== null);
        const seq = entries.length > 0 ? Number(entries[entries.length - 1].pos) : /** @type {number} */ (sinceSeq);
        return { seq, reset: false, tags, removed, hasMore: feed.more };
    }

    /** getTagChangesSeq(): the tag change feed's end. */
    async changesSeq() {
        return Number((await this.store.tagFeed('tags', 0n, 0)).end);
    }

    /**
     * getEntityTagChangesEnd(). The engine has one feed for characters and groups, so both cursors are its end.
     */
    async entityChangesEnd() {
        const end = Number((await this.store.tagFeed('entities', 0n, 0)).end);
        return { seq: end, groupsVersion: end };
    }

    /**
     * `/assignment-changes` (getEntityTagChangesSince()): the characters and groups whose tags changed past the
     * cursors, at most `limit`. Read from the lower of the two cursors, as both name a place in one feed.
     * @param {{ sinceSeq: unknown, sinceGroupsVersion: unknown }} cursors
     * @param {{ limit: number }} options
     */
    async entityChanges({ sinceSeq, sinceGroupsVersion }, { limit }) {
        const isCursor = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
        const usable = isCursor(sinceSeq) && isCursor(sinceGroupsVersion);
        const from = usable ? Math.min(/** @type {number} */ (sinceSeq), /** @type {number} */ (sinceGroupsVersion)) : 0;
        const feed = await this.store.tagFeed('entities', BigInt(from), usable ? limit : 0);
        const end = Number(feed.end);
        if (!usable || /** @type {number} */ (sinceSeq) > end || /** @type {number} */ (sinceGroupsVersion) > end) {
            return { seq: end, groupsVersion: end, endSeq: end, endGroupsVersion: end, reset: true, ids: [], hasMore: false };
        }
        const entries = /** @type {{ pos: bigint, id: bigint }[]} */ (feed.entries);
        const keys = entries.length > 0 ? await this.store.libraryKeys(entries.map(e => e.id)) : [];
        const ids = keys.filter((/** @type {any} */ k) => k !== null && k.type !== TYPE.tag).map((/** @type {any} */ k) => k.key);
        const seq = entries.length > 0 ? Number(entries[entries.length - 1].pos) : from;
        return { seq, groupsVersion: seq, endSeq: end, endGroupsVersion: end, reset: false, ids, hasMore: feed.more };
    }

    /**
     * The entity each key names, by its own type (tagEntityTypeOf()); null for a key of no type or no entity.
     * @param {unknown[]} keys
     * @returns {Promise<(bigint | null)[]>}
     */
    async entityIds(keys) {
        const types = keys.map(k => tagEntityTypeOf(k));
        /** @type {(bigint | null)[]} */
        const out = keys.map(() => null);
        for (const [type, code] of /** @type {const} */ ([['character', TYPE.character], ['group', TYPE.group]])) {
            const at = types.flatMap((t, i) => (t === type ? [i] : []));
            if (at.length === 0) continue;
            const ids = await this.lib.ids(code, at.map(i => String(keys[i])));
            at.forEach((i, j) => { out[i] = ids[j]; });
        }
        return out;
    }

    /**
     * Each tag entity's key, in the order given; null for one that has none.
     * @param {bigint[]} tags
     * @returns {Promise<(string | null)[]>}
     */
    async tagKeys(tags) {
        if (tags.length === 0) return [];
        return (await this.store.tagKeys(tags)).map((/** @type {any} */ k) => k?.key ?? null);
    }

    /**
     * `/for` (getEntityTagIdsForMany()): the tag ids each character or group carries, merges followed; [] for
     * every other key. A key only assignments name is listed too.
     * @param {unknown[]} keys
     * @returns {Promise<Record<string, string[]>>}
     */
    async tagIdsFor(keys) {
        /** @type {Record<string, string[]>} */
        const result = {};
        const distinct = [];
        for (const key of keys) {
            const k = String(key);
            if (Object.hasOwn(result, k)) continue;
            result[k] = [];
            distinct.push(key);
        }
        const ids = await this.entityIds(distinct);
        const present = /** @type {bigint[]} */ (ids.filter(id => id !== null));
        const carried = present.length > 0 ? await this.store.libraryTagIds(present) : [];
        const tagKeys = new Map();
        const allTags = [...new Set(carried.flat())];
        (await this.tagKeys(allTags)).forEach((k, i) => tagKeys.set(allTags[i], k));
        let next = 0;
        ids.forEach((id, i) => {
            if (id === null) return;
            const tags = carried[next++].map((/** @type {bigint} */ t) => tagKeys.get(t)).filter((/** @type {string | null} */ k) => k !== null);
            result[String(distinct[i])] = normalizeTagIds(tags);
        });
        return result;
    }

    /**
     * The tag entity a key names for an assignment: the live or undefined tag with it, the live tag a deleted one's
     * merges lead to, or a new undefined tag (no definition) for a key no tag ever had.
     * @param {string} key
     * @returns {Promise<{ id: bigint, key: string, reason: 'merged' | null, defined: boolean } | { id: null, reason: 'deleted' }>}
     */
    async assignable(key) {
        const [status] = await this.status([key]);
        if (status?.state === 'gone') {
            if (status.into === undefined) return { id: null, reason: 'deleted' };
            const [target] = await this.status([status.into]);
            return { id: /** @type {TagStatus} */ (target).id, key: status.into, reason: 'merged', defined: true };
        }
        if (status) return { id: status.id, key, reason: null, defined: status.state === 'live' };
        return this.lane(async () => {
            const [again] = await this.status([key]);
            if (again) return this.assignable(key);
            const id = this.lib.nextId++;
            await this.store.commit([{ kind: 'entityCreate', entity: id, type: TYPE.tag, key, added: Date.now() }]);
            return { id, key, reason: null, defined: false };
        });
    }

    /**
     * Runs `write` with the entities character or group keys name (null where there is none), after every earlier
     * write to any of them. The keys are taken in one order, so two calls naming the same entities never wait on
     * each other.
     * @template T
     * @param {string[]} keys
     * @param {(entities: (import('./library-engine.js').StoredEntity | null)[]) => Promise<T>} write
     * @returns {Promise<T>}
     */
    withEntities(keys, write) {
        const typeOf = (/** @type {string} */ key) => (tagEntityTypeOf(key) === 'character' ? TYPE.character : TYPE.group);
        const order = [...new Set(keys)].sort((a, b) => `${typeOf(a)}:${a}`.localeCompare(`${typeOf(b)}:${b}`));
        const run = async () => {
            const entities = await this.lib.entities(await Promise.all(keys.map(async key => (await this.lib.ids(typeOf(key), [key]))[0])));
            return write(entities);
        };
        return order.reduceRight((inner, key) => () => this.lib.serialized(typeOf(key), key, inner), run)();
    }

    /**
     * assignEntityTagReporting(): `assigned` is the tag the entity got, `reason` why that isn't `tagId`, `defined`
     * whether it has a definition.
     * @param {string} key A character's avatar or a group's id.
     * @param {string} tagId
     * @returns {Promise<{ result: 'ok' | 'not_found', assigned: string | null, reason: 'merged' | 'deleted' | null, defined: boolean }>}
     */
    assign(key, tagId) {
        const notFound = { result: /** @type {const} */ ('not_found'), assigned: null, reason: null, defined: false };
        if (tagEntityTypeOf(key) === null) return Promise.resolve(notFound);
        return this.withEntities([key], async ([entity]) => {
            if (!entity) return notFound;
            const tag = await this.assignable(tagId);
            if (tag.id === null) {
                console.warn(`[library-engine-tags] Not assigned to ${key}: tag deleted with no merge target: ${tagId}`);
                return { result: 'ok', assigned: null, reason: 'deleted', defined: false };
            }
            if (!entity.tags.includes(tag.id)) await this.store.commit([{ kind: 'tagAssign', entity: entity.id, tag: tag.id, assigned: true }]);
            return { result: 'ok', assigned: tag.key, reason: tag.reason, defined: tag.defined };
        });
    }

    /**
     * unassignEntityTag(): only the named tag's own assignment goes, never its merge target's.
     * @param {string} key
     * @param {string} tagId
     * @returns {Promise<'ok'>}
     */
    async unassign(key, tagId) {
        if (tagEntityTypeOf(key) === null) return 'ok';
        const [status] = await this.status([tagId]);
        if (!status) return 'ok';
        return this.withEntities([key], async ([entity]) => {
            if (entity?.tags.includes(status.id)) await this.store.commit([{ kind: 'tagAssign', entity: entity.id, tag: status.id, assigned: false }]);
            return 'ok';
        });
    }

    /**
     * The records adding `tags` to what `to` carries.
     * @param {import('./library-engine.js').StoredEntity} to
     * @param {bigint[]} tags
     */
    addRecords(to, tags) {
        const has = new Set(to.tags);
        return [...new Set(tags)].filter(t => !has.has(t)).map(tag => ({ kind: 'tagAssign', entity: to.id, tag, assigned: true }));
    }

    /**
     * copyEntityTags(): adds the tags `from` carries (merges followed) to what `to` carries.
     * @param {string} from
     * @param {string} to
     * @returns {Promise<'ok' | 'not_found'>}
     */
    async copy(from, to) {
        if (tagEntityTypeOf(from) === null || tagEntityTypeOf(to) === null) return 'not_found';
        const [fromId] = await this.entityIds([from]);
        if (fromId === null) return 'not_found';
        const [tags] = await this.store.libraryTagIds([fromId]);
        return this.withEntities([to], async ([entity]) => {
            if (!entity) return 'not_found';
            const records = this.addRecords(entity, tags);
            if (records.length > 0) await this.store.commit(records);
            return 'ok';
        });
    }

    /**
     * moveEntityTags() (`/rename-key`): adds the tags `from` carries (merges followed) to what `to` carries and
     * takes them off `from`, in one commit.
     * @param {string} from
     * @param {string} to
     * @returns {Promise<{ result: 'ok' | 'not_found', moved: string[] }>}
     */
    async move(from, to) {
        if (tagEntityTypeOf(from) === null || from === to) return { result: 'ok', moved: [] };
        return this.withEntities([from, to], async ([source, target]) => {
            if (!source || source.tags.length === 0) return { result: 'ok', moved: [] };
            if (!target) return { result: 'not_found', moved: [] };
            const [tags] = await this.store.libraryTagIds([source.id]);
            await this.store.commit([
                ...this.addRecords(target, tags),
                ...source.tags.map(tag => ({ kind: 'tagAssign', entity: source.id, tag, assigned: false })),
            ]);
            const moved = await this.tagKeys(source.tags);
            return { result: 'ok', moved: /** @type {string[]} */ (moved.filter(k => k !== null)) };
        });
    }

    /**
     * The backup's `tags`: every live tag's definition, in batches, alphabetically.
     * @returns {AsyncGenerator<Record<string, unknown>[], void, undefined>}
     */
    async* backupDefinitions() {
        /** @type {Buffer | undefined} */
        let after;
        for (;;) {
            const page = await this.store.tagPage({ sort: TAG_SORTS.alphabetical, limit: BACKUP_BATCH, cap: Number.MAX_SAFE_INTEGER, ...(after ? { after } : {}) });
            const batch = (await this.definitions(page.ids)).filter(d => d !== null);
            if (batch.length > 0) yield /** @type {Record<string, unknown>[]} */ (batch);
            if (!page.cursor) return;
            after = page.cursor;
        }
    }

    /**
     * The backup's `tag_map`: each character and group carrying tags, with their ids (merges followed), in batches.
     * @returns {AsyncGenerator<{ key: string, tagIds: string[] }[], void, undefined>}
     */
    async* backupAssignments() {
        /** @type {bigint | number} */
        let from = 0;
        for (;;) {
            const page = await this.store.tagAssignments(from, BACKUP_BATCH);
            const entries = /** @type {{ entity: bigint, tags: bigint[] }[]} */ (page.entries).filter(e => e.tags.length > 0);
            const keys = entries.length > 0 ? await this.store.libraryKeys(entries.map(e => e.entity)) : [];
            const allTags = [...new Set(entries.flatMap(e => e.tags))];
            const tagKeys = new Map();
            (await this.tagKeys(allTags)).forEach((k, i) => tagKeys.set(allTags[i], k));
            const batch = entries.flatMap((e, i) => (keys[i] === null ? [] : [{ key: keys[i].key, tagIds: e.tags.map(t => tagKeys.get(t)).filter(k => k !== null) }]));
            if (batch.length > 0) yield batch;
            if (page.next === undefined) return;
            from = page.next;
        }
    }
}
