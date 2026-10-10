import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { tagEntityTypeOf } from './group-id.js';
import { FIELD, TAG_KEY_PREFIX, TYPE } from './library-codes.js';
import { DEFAULT_TAG_NAMES, moveImportedSettingsFile, readSettingsTagsSource } from './settings-tags-source.js';
import { legacySettingsPath, settingsDirPath } from './settings-store.js';
import { compareNameKeys, tagDerivedColumns, valuesAfter, valuesBefore } from './tag-order.js';
import { contentHashOf, normalizeTagIds, tagNameKey } from '../public/scripts/hash-utils.js';

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
/** The most tags a page examines, and that numbering the tags with no order before a move's anchor reads. */
const WORK_CAP = 20000;
/** The rows a move's first window spreads when there's no room next to its anchor (tag-actions D11); it doubles. */
const MOVE_WINDOW = 16;
/** Tags a reorder pass writes per commit, and the pause between its commits. */
const PASS_BATCH = 1000;
const PASS_PAUSE_MS = 10;
/** A reorder pass's phases (`tagPass`). */
const PHASE = Object.freeze({ walk: 0, sweep: 1, drain: 2 });
/** Tags or tag_map keys a restore or an import writes per commit, and the pause between its commits. */
const IMPORT_BATCH = 500;
const IMPORT_PAUSE_MS = 10;
/**
 * `metaValue` names: the settings tags import found no source left (its time), and the store is new, so its first
 * settings tags import decides whether it gets upstream's default tags (tag-actions D34.7).
 */
export const TAG_META = Object.freeze({ settingsImported: 'settings_tags_migrated', seedPending: 'tags_seed_pending' });
/** The orders a reorder switches from (tag-actions D3). */
export const TAG_REORDER_MODES = Object.freeze(['alphabetical', 'by_entries']);

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

/**
 * @typedef {{ seq: number, tag: bigint, after: boolean, anchor?: bigint, value?: string }} Queued A queued move of
 *   the manual order: `tag` next to `anchor`, or its sort_order set to `value` (JSON).
 * @typedef {{ value: number | null } | { anchor: string, g: -1 | 1, i: number, valued?: number | null }} QueuedPlace
 *   Where the queue leaves a tag: at a sort order (`value`, null for none), or in the gap right before (g -1) or
 *   after (g 1) an anchor (an entity id as a string), at `i` in that gap's order; `valued` when the anchor had a
 *   queued value then, the gap being at that value's place in the stored order.
 * @typedef {{ tagId: string, tagName: string | null, anchorId: string | null, anchorName: string | null, refusedId: string, reason: string }} TagMoveFailed
 * @typedef {{ id: bigint, key: string, name: unknown, order: number | null, raw: unknown, hasRaw: boolean }} OrderInfo
 *   What a move reads of a tag: its recorded manual order, and the sort_order its definition holds.
 */

/**
 * A `tagQueue` record.
 * @param {number} seq
 * @param {bigint} tag
 * @param {{ after?: boolean, anchor?: bigint, value?: unknown }} entry
 */
function queueRecord(seq, tag, { after = false, anchor, value }) {
    return {
        kind: 'tagQueue',
        seq,
        tag,
        after,
        ...(anchor === undefined ? {} : { anchor }),
        ...(anchor === undefined ? { value: JSON.stringify(value) } : {}),
    };
}

/**
 * Where the queued moves leave the tags they move, as the reorder pass's drain will apply them (tag-actions D16):
 * an entry whose tag or anchor isn't live, or whose tag is its own anchor, does nothing. A tag moved next to an
 * anchor goes in the anchor's gap on that side, nearest the anchor; one moved next to a tag in a gap joins that gap
 * right beside it. A value entry puts the tag at the order its value coerces to. A tag's later entry replaces its
 * place.
 * @param {Queued[]} entries In arrival order.
 * @param {Set<string>} live The live tags among them, as strings.
 * @returns {Map<string, QueuedPlace>}
 */
export function foldQueue(entries, live) {
    /** @type {Map<string, QueuedPlace>} */
    const places = new Map();
    /** @type {Map<string, Set<string>>} Each gap's tags, by `${anchor}:${g}`. */
    const gaps = new Map();
    const leave = (/** @type {string} */ t) => {
        const p = places.get(t);
        if (p && 'anchor' in p) gaps.get(`${p.anchor}:${p.g}`)?.delete(t);
        places.delete(t);
    };
    const enter = (/** @type {string} */ t, /** @type {QueuedPlace} */ p) => {
        places.set(t, p);
        if (!('anchor' in p)) return;
        const k = `${p.anchor}:${p.g}`;
        if (!gaps.has(k)) gaps.set(k, new Set());
        gaps.get(k)?.add(t);
    };
    const members = (/** @type {string} */ anchor, /** @type {number} */ g) => [...(gaps.get(`${anchor}:${g}`) ?? [])];
    for (const e of entries) {
        const t = String(e.tag);
        if (!live.has(t)) continue;
        if (e.anchor === undefined) {
            leave(t);
            enter(t, { value: tagDerivedColumns({ sort_order: JSON.parse(/** @type {string} */ (e.value)) }).sortOrder });
            continue;
        }
        const a = String(e.anchor);
        if (t === a || !live.has(a)) continue;
        leave(t);
        const g = e.after ? 1 : -1;
        const ap = places.get(a);
        if (ap && 'anchor' in ap) {
            enter(t, { anchor: ap.anchor, g: ap.g, i: besideInGap(places, members(ap.anchor, ap.g), a, g), ...('valued' in ap ? { valued: ap.valued } : {}) });
            continue;
        }
        // Before the anchor, the newest tag is the last of its gap; after it, the first.
        const is = members(a, g).map(m => /** @type {{ i: number }} */ (places.get(m)).i);
        const i = is.length === 0 ? 0 : g === -1 ? Math.max(...is) + 1 : Math.min(...is) - 1;
        enter(t, { anchor: a, g, i, ...(ap ? { valued: /** @type {{ value: number | null }} */ (ap).value } : {}) });
    }
    return places;
}

/**
 * An i for a tag placed right beside `at` in its gap: before it (g -1) or after it (g 1). When halving can't separate
 * the two neighbours any more, the gap is numbered 1, 2, 3... first.
 * @param {Map<string, QueuedPlace>} places
 * @param {string[]} gap The gap's tags.
 * @param {string} at
 * @param {-1 | 1} g
 */
function besideInGap(places, gap, at, g) {
    const iOf = (/** @type {string} */ t) => /** @type {{ i: number }} */ (places.get(t)).i;
    const read = () => {
        const here = iOf(at);
        const beyond = gap.map(iOf).filter(i => (g === 1 ? i > here : i < here));
        return { here, next: beyond.length === 0 ? null : g === 1 ? Math.min(...beyond) : Math.max(...beyond) };
    };
    let { here, next } = read();
    if (next === null) return here + g;
    let key = (here + next) / 2;
    if (key === here || key === next) {
        [...gap].sort((x, y) => iOf(x) - iOf(y)).forEach((t, n) => {
            /** @type {{ i: number }} */ (places.get(t)).i = n + 1;
        });
        ({ here, next } = read());
        key = next === null ? here + g : (here + next) / 2;
    }
    return key;
}

/**
 * A place in a manual read with queued moves on top: the base order's cursor at `pos`, then the gap side and the
 * order in the gap (0 and 0 for a tag at its own place).
 * @typedef {{ pos: Buffer, g: number, i: number }} OverlayKey
 */

/** @param {OverlayKey} a @param {OverlayKey} b */
function compareKeys(a, b) {
    return Buffer.compare(a.pos, b.pos) || a.g - b.g || a.i - b.i;
}

/**
 * A manual cursor made with queued moves on top, or under a reorder pass: the order it was made in (`base`, the
 * pass's id, or 0 for the stored order), its place, and the tag whose own place is at `pos` and still due after a
 * cursor in the gap before it.
 * @typedef {OverlayKey & { base: number, due: string | null }} OverlayCursor
 */

/** @param {OverlayCursor} c */
function encodeCursor(c) {
    return Buffer.from(JSON.stringify(['o', c.base, c.pos.toString('base64url'), c.g, c.i, c.due]), 'utf8').toString('base64url');
}

/**
 * @param {string} cursor
 * @returns {OverlayCursor | { plain: Buffer } | null} A manual cursor of either form, or null for one that is neither.
 */
function decodeCursor(cursor) {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.length === 0) return null;
    if (bytes[0] !== 0x5b) return { plain: bytes };
    try {
        const [tag, base, pos, g, i, due] = JSON.parse(bytes.toString('utf8'));
        const ok = tag === 'o' && Number.isSafeInteger(base) && typeof pos === 'string' && [-1, 0, 1].includes(g)
            && typeof i === 'number' && Number.isFinite(i) && (due === null || typeof due === 'string');
        return ok ? { base, pos: Buffer.from(pos, 'base64url'), g, i, due } : null;
    } catch {
        return null;
    }
}

/** @param {OrderInfo} info */
function label(info) {
    return `${info.key} (${typeof info.name === 'string' ? info.name : JSON.stringify(info.name)})`;
}

const delay = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Emits 'tag-changes' after a reorder pass changed definitions, 'tag-order-settled' once a pass has ended, and
 * 'tag-move-failed' with a TagMoveFailed for each queued move that couldn't be applied (tag-actions D19).
 */
export class LibraryTags extends EventEmitter {
    /**
     * @param {import('./library-engine.js').LibraryEngine} lib
     */
    constructor(lib) {
        super();
        this.lib = lib;
        this.store = lib.store;
        /** @type {Promise<void> | null} */
        this.passRun = null;
        this.passWanted = false;
        /** Tags a reorder pass writes per commit. */
        this.passBatch = PASS_BATCH;
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
            const assignOrder = !Object.hasOwn(tag, 'sort_order');
            if (assignOrder) tag.sort_order = await this.nextOrder();
            // While moves queue, an own order is queued too, so the last entry for a tag wins (tag-actions D28).
            const seq = !assignOrder && !(await this.settled()) ? await this.nextSeq() : null;
            await this.lib.writeTag(/** @type {any} */ (tag), seq === null ? {} : { extra: id => [queueRecord(seq, id, { value: tag.sort_order })] });
            return { refused: [], tag };
        });
    }

    /**
     * editTagDefinition(): the patch over the stored definition, written only when that changes it. While moves
     * queue, a patched sort_order is queued instead, after them, so the last entry for a tag wins (tag-actions D18,
     * D28); the other fields are written at once.
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
            const { sort_order: patchedOrder, ...rest } = patch;
            const seq = Object.hasOwn(patch, 'sort_order') && !(await this.settled()) ? await this.nextSeq() : null;
            const queued = seq === null ? [] : [queueRecord(seq, status.id, { value: patchedOrder })];
            const merged = { ...old, ...(seq === null ? patch : rest), id };
            if (JSON.stringify(merged) !== JSON.stringify(old)) await this.lib.writeTag(/** @type {any} */ (merged), { extra: () => queued });
            else if (queued.length > 0) await this.store.commit(queued);
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
        if (sort === TAG_SORTS.manual) {
            const overlay = await this.manualOverlay();
            const cursor = typeof params.cursor === 'string' ? decodeCursor(params.cursor) : null;
            if (overlay || cursor?.base !== undefined) {
                return this.overlayQuery(params, q, overlay ?? { base: TAG_SORTS.manual, baseTag: 0, queue: [] }, cursor);
            }
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

    // ---- the manual order: moves, reorders and the queue ----

    /**
     * Every queued move, in order.
     * @returns {Promise<Queued[]>}
     */
    async queue() {
        /** @type {Queued[]} */
        const out = [];
        let after = 0;
        for (;;) {
            const page = await this.store.tagQueue(after, 1000);
            out.push(...page.entries);
            if (!page.more) return out;
            after = out[out.length - 1].seq;
        }
    }

    /** The next queued move's seq. */
    async nextSeq() {
        const queue = await this.queue();
        return queue.length > 0 ? queue[queue.length - 1].seq + 1 : 1;
    }

    /** Whether a move applies now: no reorder pass runs and nothing is queued. */
    async settled() {
        const [pass, queue] = await Promise.all([this.store.tagPass(), this.store.tagQueue(0, 1)]);
        return pass.mode === undefined && queue.entries.length === 0;
    }

    /**
     * @param {bigint[]} ids
     * @returns {Promise<OrderInfo[]>} null where there is no tag.
     */
    async orderInfo(ids) {
        if (ids.length === 0) return [];
        return (await this.lib.entities(ids)).map((e) => {
            if (!e) return /** @type {any} */ (null);
            const def = tagDefinition(e);
            return { id: e.id, key: e.key, name: def.name, order: e.tagOrder ?? null, raw: def.sort_order, hasRaw: Object.hasOwn(def, 'sort_order') };
        });
    }

    /**
     * The records giving a tag `value` as its sort_order: the stored value when it differs, and its coerced order
     * (stamped by reorder pass `pass` when given).
     * @param {OrderInfo} info
     * @param {unknown} value
     * @param {number} [pass]
     */
    orderRecords(info, value, pass) {
        const records = [];
        const json = JSON.stringify(value);
        if (!info.hasRaw || JSON.stringify(info.raw) !== json) records.push({ kind: 'jsonValue', entity: info.id, field: `${TAG_KEY_PREFIX}sort_order`, json });
        const order = tagDerivedColumns({ sort_order: value }).sortOrder;
        const coerced = order === null ? {} : { order };
        if (pass !== undefined) records.push({ kind: 'tagPassOrder', tag: info.id, ...coerced, pass });
        else if (info.order !== order) records.push({ kind: 'tagOrder', tag: info.id, ...coerced });
        return records;
    }

    /**
     * The records putting back the sort_order `info` was read with.
     * @param {OrderInfo} info
     */
    restoreRecords(info) {
        const field = `${TAG_KEY_PREFIX}sort_order`;
        return [
            info.hasRaw ? { kind: 'jsonValue', entity: info.id, field, json: JSON.stringify(info.raw) } : { kind: 'valueDelete', entity: info.id, field },
            { kind: 'tagOrder', tag: info.id, ...(info.order === null ? {} : { order: info.order }) },
        ];
    }

    /**
     * What a move refuses whatever the order: the tag as its own anchor ('same'), then per tag 'deleted' or
     * 'missing'.
     * @param {string} key
     * @param {string} anchorKey
     * @returns {Promise<{ refused: TagRefusal[], moved?: bigint, anchor?: bigint }>}
     */
    async readMove(key, anchorKey) {
        if (key === anchorKey) return { refused: [{ id: key, reason: 'same' }] };
        const statuses = await this.status([key, anchorKey]);
        /** @type {TagRefusal[]} */
        const refused = [];
        [key, anchorKey].forEach((k, i) => {
            if (statuses[i]?.state === 'gone') refused.push({ id: k, reason: 'deleted' });
            else if (statuses[i]?.state !== 'live') refused.push({ id: k, reason: 'missing' });
        });
        return { refused, moved: statuses[0]?.id, anchor: statuses[1]?.id };
    }

    /**
     * The tags with an order next to `from` in the manual order, nearest first: before it (`down`) or after it.
     * @param {bigint} from
     * @param {{ down: boolean, inclusive: boolean, skip: bigint | null, limit: number }} options
     * @returns {Promise<OrderInfo[]>}
     */
    async manualRows(from, { down, inclusive, skip, limit }) {
        /** @type {bigint[]} */
        const ids = [];
        if (inclusive && from !== skip) ids.push(from);
        let [after] = await this.store.tagPositions(TAG_SORTS.manual, [{ id: from }]);
        while (ids.length < limit && after) {
            const page = await this.store.tagPage({ sort: TAG_SORTS.manual, ordered: true, reverse: down, after, limit: limit - ids.length + 1, cap: Number.MAX_SAFE_INTEGER });
            for (const id of page.ids) if (id !== skip && ids.length < limit) ids.push(id);
            after = page.cursor;
        }
        return this.orderInfo(ids);
    }

    /**
     * Gives `moved` a sort order right before or after `anchor` (which has one): the midpoint with the anchor's
     * neighbour on that side, or past the anchor at an end of the order; failing that, it spreads a window of tags
     * around the anchor, doubling it until there is room.
     * @param {OrderInfo} moved
     * @param {OrderInfo} anchor
     * @param {'before' | 'after'} side
     * @returns {Promise<{ info: OrderInfo, value: number }[] | 'no-room'>} The tags whose orders change; none when the
     *   tag is in that place already.
     */
    async placeNextTo(moved, anchor, side) {
        const a = /** @type {number} */ (anchor.order);
        const [neighbour] = await this.manualRows(anchor.id, { down: side === 'before', inclusive: false, skip: null, limit: 1 });
        if (neighbour?.id === moved.id) return [];
        /** @type {number | undefined} */
        let value;
        if (neighbour) {
            const b = /** @type {number} */ (neighbour.order);
            const m = (a + b) / 2;
            if (Number.isFinite(m) && Math.min(a, b) < m && m < Math.max(a, b)) value = m;
        } else {
            const v = (side === 'after' ? valuesAfter(a, 1) : valuesBefore(a, 1)).at(0);
            if (v !== undefined && Number.isFinite(v) && (side === 'after' ? v > a : v < a)) value = v;
        }
        if (value !== undefined) return [{ info: moved, value }];

        for (let size = MOVE_WINDOW; ; size *= 2) {
            const half = size / 2;
            // The gap is between the two sides: "before" puts the anchor first on the right, "after" last on the left.
            const left = await this.manualRows(anchor.id, { down: true, inclusive: side === 'after', skip: moved.id, limit: half + 1 });
            const right = await this.manualRows(anchor.id, { down: false, inclusive: side === 'before', skip: moved.id, limit: half + 1 });
            // A side with more than `half` tags hasn't reached its end of the order; its extra tag is the bound.
            const leftBound = left.length > half ? left.pop() : undefined;
            const rightBound = right.length > half ? right.pop() : undefined;
            const sequence = [...left.reverse(), moved, ...right];
            const n = sequence.length;
            const lo = leftBound && leftBound.order !== -Infinity ? /** @type {number} */ (leftBound.order) : null;
            const hi = rightBound && rightBound.order !== Infinity ? /** @type {number} */ (rightBound.order) : null;
            const values = lo !== null && hi !== null
                ? sequence.map((_, i) => lo + (hi - lo) * (i + 1) / (n + 1))
                : lo !== null ? valuesAfter(lo, n) : hi !== null ? valuesBefore(hi, n) : valuesAfter(0, n);
            const valid = values.length === n && values.every((v, i) => Number.isFinite(v)
                && (i === 0 ? lo === null || v > lo : v > values[i - 1])
                && (i < n - 1 || hi === null || v < hi));
            if (valid) return sequence.flatMap((info, i) => (values[i] === info.order ? [] : [{ info, value: values[i] }]));
            if (!leftBound && !rightBound) return 'no-room';
        }
    }

    /**
     * The tags with no order from the first through `anchor`, under the work cap, numbered after the highest
     * order (upstream newTag()'s Math.max(0, ...orders) + 1 upward); `moved` stays without one.
     * @param {OrderInfo} anchor
     * @param {OrderInfo} moved
     * @returns {Promise<{ info: OrderInfo, value: number }[] | 'unordered' | 'no-room'>} 'unordered': the anchor is
     *   past the work cap.
     */
    async numberTail(anchor, moved) {
        /** @type {bigint[]} */
        const ids = [];
        /** @type {Buffer | undefined} */
        let after;
        let found = false;
        while (!found && ids.length < WORK_CAP) {
            const page = await this.store.tagPage({ sort: TAG_SORTS.manual, ordered: false, limit: Math.min(1000, WORK_CAP - ids.length), cap: Number.MAX_SAFE_INTEGER, ...(after ? { after } : {}) });
            for (const id of page.ids) {
                ids.push(id);
                if (id === anchor.id) {
                    found = true;
                    break;
                }
            }
            if (!page.cursor) break;
            after = page.cursor;
        }
        if (!found) return 'unordered';
        const infos = await this.orderInfo(ids.filter(id => id !== moved.id));
        const max = await this.store.tagMaxOrder();
        const values = valuesAfter(Math.max(0, max ?? 0), infos.length);
        if (values.length < infos.length) return 'no-room';
        return infos.map((info, i) => ({ info, value: values[i] }));
    }

    /**
     * Moves tag `key` right before or after `anchorKey` in the manual order, as it stands now. An anchor with no
     * order first gets one, with the tags with none before it, written at once (their order as shown doesn't
     * change); the move's own records are returned for the caller to commit.
     * @param {string} key
     * @param {string} anchorKey
     * @param {'before' | 'after'} side
     * @returns {Promise<{ refused: TagRefusal[], records: object[], written: { id: string, sort_order: number }[], warnings: string[] }>}
     */
    async applyMove(key, anchorKey, side) {
        const read = await this.readMove(key, anchorKey);
        if (read.refused.length > 0) return { refused: read.refused, records: [], written: [], warnings: [] };
        const ids = /** @type {bigint[]} */ ([read.moved, read.anchor]);
        let [moved, anchor] = await this.orderInfo(ids);
        const none = { refused: [], records: [], written: [], warnings: [] };
        const noRoom = () => ({ ...none, refused: [{ id: key, reason: 'no-room' }], warnings: [`[library-engine-tags] Couldn't move tag ${label(moved)} ${side} ${label(anchor)}: there is no room for a sort_order there.`] });
        /** @type {{ info: OrderInfo, value: number }[]} */
        let tail = [];
        if (anchor.order === null) {
            if (side === 'before' && moved.order === null) {
                const [pos] = await this.store.tagPositions(TAG_SORTS.manual, [{ id: anchor.id }]);
                const [previous] = (await this.store.tagPage({ sort: TAG_SORTS.manual, ordered: false, reverse: true, after: pos, limit: 1 })).ids;
                if (previous === moved.id) return none;
            }
            const numbered = await this.numberTail(anchor, moved);
            if (numbered === 'unordered') return { ...none, refused: [{ id: anchorKey, reason: 'unordered' }] };
            if (numbered === 'no-room') return noRoom();
            tail = numbered;
            await this.store.commit(tail.flatMap(w => this.orderRecords(w.info, w.value)));
            [moved, anchor] = await this.orderInfo([moved.id, anchor.id]);
        }
        const placed = await this.placeNextTo(moved, anchor, side);
        if (placed === 'no-room') {
            if (tail.length > 0) await this.store.commit(tail.flatMap(w => this.restoreRecords(w.info)));
            return noRoom();
        }
        const replaced = tail.filter(w => w.info.hasRaw).map(w => `  ${label(w.info)}: ${JSON.stringify(w.info.raw)}`);
        return {
            refused: [],
            records: placed.flatMap(w => this.orderRecords(w.info, w.value)),
            written: [...tail, ...placed].map(w => ({ id: w.info.key, sort_order: w.value })),
            warnings: replaced.length === 0 ? [] : [`[library-engine-tags] Tag move: ${replaced.length} tag(s) whose sort_order had no order (non-numeric, NaN or an object) were given one; their old values:\n${replaced.join('\n')}`],
        };
    }

    /**
     * moveTagDefinition(): tag `key` right before or after an anchor tag in the manual order. While a reorder pass
     * runs or moves are queued, it is queued instead, after checking what the order can't change.
     * @param {string} key
     * @param {{ before?: string, after?: string }} placement
     * @returns {Promise<{ refused: TagRefusal[], written: { id: string, sort_order: number }[], queued?: true }>}
     *   written: every tag the move wrote, with the sort_order now stored.
     */
    moveDefinition(key, placement) {
        const side = placement.before !== undefined ? 'before' : 'after';
        const anchorKey = /** @type {string} */ (placement.before ?? placement.after);
        return this.lane(async () => {
            if (!(await this.settled())) {
                const read = await this.readMove(key, anchorKey);
                if (read.refused.length > 0) return { refused: read.refused, written: [] };
                await this.store.commit([queueRecord(await this.nextSeq(), /** @type {bigint} */ (read.moved), { after: side === 'after', anchor: read.anchor })]);
                return { refused: [], written: [], queued: /** @type {const} */ (true) };
            }
            const result = await this.applyMove(key, anchorKey, side);
            if (result.records.length > 0) await this.store.commit(result.records);
            for (const line of result.warnings) console.warn(line);
            // A tag written twice (its tail number, then its window's) has the later one stored.
            return { refused: result.refused, written: [...new Map(result.written.map(w => [w.id, w])).values()] };
        });
    }

    /**
     * reorderTagDefinitions(): a move made while viewing `mode`'s order. A reorder pass will write every tag's
     * sort_order in that order, then apply the queued moves, this one last; a running pass is replaced. The caller
     * starts the pass (startPass()) once it has answered.
     * @param {string} key
     * @param {{ before?: string, after?: string }} placement
     * @param {'alphabetical' | 'by_entries'} mode
     * @returns {Promise<{ refused: TagRefusal[], queued: boolean }>}
     */
    reorderDefinitions(key, placement, mode) {
        const side = placement.before !== undefined ? 'before' : 'after';
        const anchorKey = /** @type {string} */ (placement.before ?? placement.after);
        return this.lane(async () => {
            const read = await this.readMove(key, anchorKey);
            if (read.refused.length > 0) return { refused: read.refused, queued: false };
            const { pass } = await this.store.tagPass();
            await this.store.commit([
                { kind: 'tagPass', pass: pass + 1, mode: TAG_SORTS[mode], phase: PHASE.walk, n: 0 },
                queueRecord(await this.nextSeq(), /** @type {bigint} */ (read.moved), { after: side === 'after', anchor: read.anchor }),
            ]);
            return { refused: [], queued: true };
        });
    }

    /**
     * Runs the recorded reorder pass to its end, in batches with pauses between them, unless it already runs; a
     * pass recorded meanwhile is run too. Started by a reorder, and after the server is listening for one a stop
     * left recorded.
     * @returns {Promise<void>}
     */
    startPass() {
        this.passWanted = true;
        if (this.passRun) return this.passRun;
        this.passRun = (async () => {
            try {
                while (this.passWanted) {
                    this.passWanted = false;
                    while (await this.lane(() => this.passStep())) await delay(PASS_PAUSE_MS);
                }
            } catch (err) {
                console.error('[library-engine-tags] The tag reorder pass stopped:', err);
            } finally {
                this.passRun = null;
            }
        })();
        return this.passRun;
    }

    /**
     * One batch of the reorder pass (tag-actions D15, D16, D19, D25):
     * 1. walk: every tag, in the pass mode's live order, gets sort_order 0, 1, 2, ...;
     * 2. sweep: until the pass has written every live tag, those it hasn't (their place moved behind the walk, or
     *    made meanwhile) get orders after the highest, in the mode's order;
     * 3. drain: the queued moves apply in arrival order, one per commit, then the pass ends.
     * @returns {Promise<boolean>} Whether there is more to do.
     */
    async passStep() {
        const st = await this.store.tagPass();
        if (st.mode === undefined) return false;
        const record = (/** @type {object} */ fields) => ({ kind: 'tagPass', pass: st.pass, mode: st.mode, ...fields });
        if (st.phase === PHASE.walk) {
            const page = await this.store.tagPage({ sort: st.mode, limit: this.passBatch, cap: Number.MAX_SAFE_INTEGER, ...(st.after ? { after: st.after } : {}) });
            const infos = (await this.orderInfo(page.ids)).filter(i => i !== null);
            let n = st.n ?? 0;
            const records = [];
            const replaced = [];
            for (const info of infos) {
                if (info.hasRaw && tagDerivedColumns({ sort_order: info.raw }).sortOrder === null) replaced.push(`  ${label(info)}: ${JSON.stringify(info.raw)}`);
                records.push(...this.orderRecords(info, n++, st.pass));
            }
            records.push(page.cursor ? record({ phase: PHASE.walk, n, after: page.cursor }) : record({ phase: PHASE.sweep }));
            await this.store.commit(records);
            this.warnReplaced(st.pass, replaced);
            if (infos.length > 0) this.emit('tag-changes');
            return true;
        }
        if (st.phase === PHASE.sweep) {
            if (st.stamped >= st.live) {
                await this.store.commit([record({ phase: PHASE.drain })]);
                return true;
            }
            const page = await this.store.tagPage({ sort: st.mode, unstamped: st.pass, limit: this.passBatch, cap: WORK_CAP, ...(st.after ? { after: st.after } : {}) });
            if (page.ids.length === 0 && !page.cursor) {
                if (!st.after) {
                    console.error(`[library-engine-tags] Tag reorder pass ${st.pass}: ${st.live - st.stamped} live tag(s) are counted as not written, but none was found; draining.`);
                    await this.store.commit([record({ phase: PHASE.drain })]);
                } else {
                    await this.store.commit([record({ phase: PHASE.sweep })]);
                }
                return true;
            }
            const infos = (await this.orderInfo(page.ids)).filter(i => i !== null);
            const max = await this.store.tagMaxOrder();
            const values = valuesAfter(Math.max(0, max ?? 0), infos.length);
            const records = [];
            const replaced = [];
            const unplaced = [];
            infos.forEach((info, i) => {
                if (values[i] === undefined) {
                    unplaced.push(`  ${label(info)}`);
                    records.push({ kind: 'tagPassOrder', tag: info.id, ...(info.order === null ? {} : { order: info.order }), pass: st.pass });
                    return;
                }
                if (info.hasRaw && tagDerivedColumns({ sort_order: info.raw }).sortOrder === null) replaced.push(`  ${label(info)}: ${JSON.stringify(info.raw)}`);
                records.push(...this.orderRecords(info, values[i], st.pass));
            });
            records.push(record({ phase: PHASE.sweep, ...(page.cursor ? { after: page.cursor } : {}) }));
            await this.store.commit(records);
            this.warnReplaced(st.pass, replaced);
            if (unplaced.length > 0) console.warn(`[library-engine-tags] Tag reorder pass ${st.pass}: ${unplaced.length} tag(s) were left where they are: no finite value is left after the current max sort_order:\n${unplaced.join('\n')}`);
            if (infos.length > 0) this.emit('tag-changes');
            return true;
        }
        const [entry] = (await this.store.tagQueue(0, 1)).entries;
        if (!entry) {
            await this.store.commit([{ kind: 'tagPass', pass: st.pass }]);
            console.log(`[library-engine-tags] Tag reorder pass ${st.pass}: done.`);
            this.emit('tag-order-settled');
            return false;
        }
        await this.applyQueued(/** @type {Queued} */ (entry));
        return true;
    }

    /**
     * Applies the first queued move and pops it, in one commit (tag-actions D16, D18, D19). An anchored move is
     * made as moveDefinition() makes it; a value is written as the tag's sort_order. A move whose tag is gone, or
     * is its own anchor, is dropped; any other refusal leaves the tags as they are and is reported.
     * @param {Queued} entry
     */
    async applyQueued(entry) {
        const pop = { kind: 'tagQueuePop', seq: entry.seq };
        const [key, anchorKey] = await this.tagKeys([entry.tag, ...(entry.anchor === undefined ? [] : [entry.anchor])]);
        if (key === null) {
            await this.store.commit([pop]);
            return;
        }
        if (entry.anchor === undefined) {
            const [status] = await this.status([key]);
            const [info] = status?.state === 'live' ? await this.orderInfo([status.id]) : [null];
            const value = JSON.parse(/** @type {string} */ (entry.value));
            const records = info && !(info.hasRaw && JSON.stringify(info.raw) === JSON.stringify(value)) ? this.orderRecords(info, value) : [];
            await this.store.commit([...records, pop]);
            if (records.length > 0) this.emit('tag-changes');
            return;
        }
        const result = await this.applyMove(key, /** @type {string} */ (anchorKey), entry.after ? 'after' : 'before');
        await this.store.commit([...result.records, pop]);
        for (const line of result.warnings) console.warn(line);
        if (result.written.length > 0) this.emit('tag-changes');
        const dropped = result.refused.some(r => r.reason === 'same' || (r.id === key && (r.reason === 'deleted' || r.reason === 'missing')));
        if (result.refused.length === 0 || dropped) return;
        const pair = /** @type {string[]} */ ([key, anchorKey]);
        const names = await this.definitions((await this.status(pair)).map(st => (st?.state === 'live' ? st.id : 0n)));
        const nameOf = (/** @type {Record<string, unknown> | null} */ d) => (typeof d?.name === 'string' ? d.name : null);
        for (const r of result.refused) {
            /** @type {TagMoveFailed} */
            const failed = { tagId: key, tagName: nameOf(names[0]), anchorId: anchorKey, anchorName: nameOf(names[1]), refusedId: r.id, reason: r.reason === 'missing' ? 'deleted' : r.reason };
            console.warn(`[library-engine-tags] Couldn't move tag ${key} next to ${anchorKey}: ${failed.reason} (${r.id}).`);
            this.emit('tag-move-failed', failed);
        }
    }

    /**
     * @param {number} pass
     * @param {string[]} replaced
     */
    warnReplaced(pass, replaced) {
        if (replaced.length > 0) console.warn(`[library-engine-tags] Tag reorder pass ${pass}: ${replaced.length} tag(s) whose sort_order had no order (non-numeric, NaN or an object) were given one; their old values:\n${replaced.join('\n')}`);
    }

    /**
     * What a manual read shows on top of the stored order: the queued moves, and while a reorder pass walks or
     * sweeps, the pass mode's order in place of the stored one (tag-actions D16, D24, D26). Null when neither.
     * @returns {Promise<{ base: number, baseTag: number, queue: Queued[] } | null>}
     */
    async manualOverlay() {
        const [pass, queue] = await Promise.all([this.store.tagPass(), this.queue()]);
        const passBase = pass.mode !== undefined && pass.phase !== PHASE.drain;
        if (!passBase && queue.length === 0) return null;
        return { base: passBase ? /** @type {number} */ (pass.mode) : TAG_SORTS.manual, baseTag: passBase ? pass.pass : 0, queue };
    }

    /**
     * A manual page with the queued moves on top, in the stored order or a reorder pass mode's. Each moved tag shows
     * where the queue leaves it; under a pass a queued value counts for nothing, so its tag shows at its own place
     * (tag-actions D24). A cursor names the order it was made in, and is refused in any other.
     * @param {Parameters<LibraryTags['query']>[0]} params
     * @param {Record<string, unknown>} q The engine query for the filters, `ids` resolved.
     * @param {{ base: number, baseTag: number, queue: Queued[] }} overlay
     * @param {OverlayCursor | { plain: Buffer } | null} cursor
     */
    async overlayQuery(params, q, { base, baseTag, queue }, cursor) {
        /** @type {OverlayCursor | null} */
        let after = null;
        if (cursor && 'plain' in cursor) {
            if (baseTag !== 0 || cursor.plain[0] !== TAG_SORTS.manual) return 'invalid-cursor';
            after = { base: 0, pos: cursor.plain, g: 0, i: 0, due: null };
        } else if (cursor) {
            if (cursor.base !== baseTag) return 'invalid-cursor';
            after = cursor;
        } else if (typeof params.cursor === 'string') {
            return 'invalid-cursor';
        }
        const ids = [...new Set(queue.flatMap(e => [e.tag, ...(e.anchor === undefined ? [] : [e.anchor])]))];
        const keys = ids.length > 0 ? await this.store.tagKeys(ids) : [];
        const live = new Set(ids.filter((_, i) => keys[i]?.state === 'live').map(String));
        const stored = baseTag === 0;
        /** @type {Map<string, { key: OverlayKey, due: string | null }>} */
        const placed = new Map();
        /** @type {{ id: bigint, order?: number | null }[]} */
        const items = [];
        const places = [...foldQueue(queue, live)].filter(([, p]) => stored || 'anchor' in p);
        for (const [t, p] of places) {
            if ('anchor' in p) items.push(stored && 'valued' in p ? { id: BigInt(p.anchor), order: p.valued } : { id: BigInt(p.anchor) });
            else items.push({ id: BigInt(t), order: p.value });
        }
        const positions = items.length > 0 ? await this.store.tagPositions(base, items) : [];
        places.forEach(([t, p], n) => {
            const pos = positions[n];
            if (!pos) return;
            if ('anchor' in p) placed.set(t, { key: { pos, g: p.g, i: p.i }, due: p.g === -1 && !(stored && 'valued' in p) ? p.anchor : null });
            else placed.set(t, { key: { pos, g: 0, i: 0 }, due: null });
        });
        const filters = { ...q, sort: base };
        delete filters.limit;
        delete filters.ids;
        const passing = async (/** @type {bigint[]} */ wanted) => (wanted.length === 0 ? new Set() : new Set((await this.store.tagPage({ ...filters, ids: wanted, limit: wanted.length })).ids.map(String)));
        const pageSize = params.pageSize;
        /** @type {{ id: bigint, key: OverlayKey, due: string | null }[]} */
        const shown = [];
        const done = (/** @type {boolean} */ more) => this.overlayResult(params, shown, baseTag, more, shown.length === pageSize || more);

        if (q.ids) {
            const wanted = [...(await passing(/** @type {bigint[]} */ (q.ids)))].map(BigInt);
            const own = wanted.filter(id => !placed.has(String(id)));
            const ownPos = own.length > 0 ? await this.store.tagPositions(base, own.map(id => ({ id }))) : [];
            const all = [
                ...own.flatMap((id, n) => (ownPos[n] ? [{ id, key: { pos: ownPos[n], g: 0, i: 0 }, due: null }] : [])),
                ...wanted.filter(id => placed.has(String(id))).map(id => ({ id, ...(placed.get(String(id))) })),
            ].filter(e => !after || compareKeys(e.key, after) > 0).sort((x, y) => compareKeys(x.key, y.key));
            shown.push(...all.slice(0, pageSize));
            return done(false);
        }

        const overlayPassing = await passing([...placed.keys()].map(BigInt));
        const overlay = [...placed].filter(([t, e]) => overlayPassing.has(t) && (!after || compareKeys(e.key, after) > 0))
            .map(([t, e]) => ({ id: BigInt(t), ...e }))
            .sort((x, y) => compareKeys(x.key, y.key));
        /** @type {{ id: bigint, key: OverlayKey, due: string | null }[]} */
        const rows = [];
        // A cursor in the gap before a tag's own place leaves that place still to read.
        if (after?.due && after.g === -1 && !placed.has(after.due)) {
            const due = BigInt(after.due);
            const [pos] = await this.store.tagPositions(base, [{ id: due }]);
            if (pos && pos.equals(after.pos) && (await passing([due])).has(after.due)) rows.push({ id: due, key: { pos, g: 0, i: 0 }, due: null });
        }
        /** @type {Buffer | null | undefined} undefined: not read yet; null: read to its end. */
        let rowAfter = after ? after.pos : undefined;
        let capped = false;
        let next = 0;
        while (shown.length < pageSize) {
            if (rows.length === 0 && rowAfter !== null && !capped) {
                const page = await this.store.tagPage({ ...filters, limit: pageSize - shown.length + 1, cap: WORK_CAP, ...(rowAfter ? { after: rowAfter } : {}) });
                const free = page.ids.filter((/** @type {bigint} */ id) => !placed.has(String(id)));
                const pos = free.length > 0 ? await this.store.tagPositions(base, free.map((/** @type {bigint} */ id) => ({ id }))) : [];
                free.forEach((/** @type {bigint} */ id, /** @type {number} */ n) => rows.push({ id, key: { pos: pos[n], g: 0, i: 0 }, due: null }));
                rowAfter = page.cursor ?? null;
                if (page.more) capped = true;
                if (rows.length === 0 && rowAfter !== null && !capped) continue;
            }
            const row = rows[0];
            const item = overlay[next];
            if (capped && rows.length === 0) {
                // The work cap stopped the walk at `rowAfter`: what lies before it is read, the rest is for next time.
                const stop = { pos: /** @type {Buffer} */ (rowAfter), g: 0, i: 0 };
                while (overlay[next] && compareKeys(overlay[next].key, stop) < 0 && shown.length < pageSize) shown.push(overlay[next++]);
                if (shown.length < pageSize) return this.overlayResult(params, [...shown, { id: -1n, key: stop, due: null }], baseTag, true, true);
                return done(false);
            }
            if (!row && !item) return done(false);
            if (row && (!item || compareKeys(row.key, item.key) < 0)) shown.push(/** @type {any} */ (rows.shift()));
            else {
                shown.push(item);
                next++;
            }
        }
        return done(false);
    }

    /**
     * A manual page's answer from the places it reached: the shown tags' definitions, and the cursor at the last
     * place.
     * @param {Parameters<LibraryTags['query']>[0]} params
     * @param {{ id: bigint, key: OverlayKey, due: string | null }[]} reached The last may be the work cap's stop (id -1).
     * @param {number} baseTag
     * @param {boolean} more
     * @param {boolean} withCursor
     */
    async overlayResult(params, reached, baseTag, more, withCursor) {
        const shownIds = reached.filter(e => e.id !== -1n).map(e => e.id);
        const rows = /** @type {Record<string, unknown>[]} */ ((await this.definitions(shownIds)).filter(d => d !== null));
        const last = reached[reached.length - 1];
        const cursor = withCursor && last ? encodeCursor({ base: baseTag, ...last.key, due: last.due }) : null;
        const result = { rows, cursor, more };
        if (!params.counts) return result;
        return { ...result, ...(await this.counts(shownIds, rows.map(r => /** @type {string} */ (r.id)))) };
    }

    // ---- restore and the settings import ----

    /**
     * The tag a definition being restored or imported names: the live one with its id, else (with `byName`) the
     * first live one with its name; and whether its id is a deleted tag's.
     * @param {string} id
     * @param {string} name
     * @param {boolean} byName
     * @returns {Promise<{ existing: TagStatus & { key: string } | null, gone: boolean }>}
     */
    async definitionTarget(id, name, byName) {
        const [status] = await this.status([id]);
        if (status?.state === 'live') return { existing: { ...status, key: id }, gone: false };
        const gone = status?.state === 'gone';
        if (!byName) return { existing: null, gone };
        const [found] = await this.store.tagByNames([name]);
        if (found === null) return { existing: null, gone };
        const [key] = await this.tagKeys([found]);
        return { existing: { id: found, state: 'live', key: /** @type {string} */ (key) }, gone };
    }

    /**
     * Definitions in the order they are created in: those with their own sort_order as listed, then the rest by name,
     * as upstream shows them (the list's order kept for equal names).
     * @template {{ name?: unknown }} T
     * @param {T[]} tags
     * @returns {T[]}
     */
    static creationOrder(tags) {
        const ordered = tags.filter(t => Object.hasOwn(t, 'sort_order'));
        const orderless = tags.filter(t => !Object.hasOwn(t, 'sort_order'));
        const key = (/** @type {T} */ t) => (typeof t.name === 'string' ? tagNameKey(t.name) : '');
        orderless.sort((a, b) => compareNameKeys(key(a), key(b)));
        return [...ordered, ...orderless];
    }

    /**
     * Writes definitions in batches of IMPORT_BATCH, each batch in the lane and committed together, a pause between
     * batches. `decide` reads the store and returns what to write for an item, if anything: the definition, the name
     * keys it touches, a sort_order to queue while moves queue (`queue`, when present), and an order the next
     * created tag's must come after (`bump`). An item whose id or name an earlier write of the batch touched is
     * decided once that write is committed.
     * @template T
     * @param {T[]} sequence
     * @param {(item: T, batch: { next: number, settled: boolean }) => Promise<{ tag: Record<string, unknown> & { id: string }, names: string[], queue?: unknown, bump: number | null } | null>} decide
     */
    async writeDefinitions(sequence, decide) {
        for (let i = 0; i < sequence.length; i += IMPORT_BATCH) {
            if (i > 0) await delay(IMPORT_PAUSE_MS);
            await this.lane(async () => {
                const settled = await this.settled();
                let seq = settled ? 0 : await this.nextSeq();
                const batch = { next: await this.nextOrder(), settled };
                /** @type {object[]} */
                let records = [];
                const touched = new Set();
                for (const item of sequence.slice(i, i + IMPORT_BATCH)) {
                    const { id, name } = /** @type {{ id?: unknown, name?: unknown }} */ (item);
                    const nameKey = typeof name === 'string' ? tagNameKey(name) : '';
                    if (records.length > 0 && (touched.has(`id:${id}`) || touched.has(`name:${nameKey}`))) {
                        await this.store.commit(records);
                        records = [];
                        touched.clear();
                    }
                    const write = await decide(item, batch);
                    if (!write) continue;
                    const { id: entity, records: own } = await this.lib.tagRecords(write.tag);
                    records.push(...own);
                    if (!settled && Object.hasOwn(write, 'queue')) records.push(queueRecord(seq++, entity, { value: write.queue }));
                    if (write.bump !== null && write.bump >= batch.next) batch.next = write.bump + 1;
                    touched.add(`id:${write.tag.id}`);
                    for (const n of write.names) touched.add(`name:${n}`);
                }
                if (records.length > 0) await this.store.commit(records);
            });
        }
    }

    /**
     * restoreTagBackup(): a backup's definitions, then its assignments, so no assignment names a tag that isn't
     * there. A backup tag is the live tag with its id, else the first live one with its name, and is created when
     * there is neither; a deleted tag's id is created under a new id. `overwrite` writes the backup's fields onto the
     * stored tag as edit() does, leaving out a name another live tag has. Created tags with no sort_order get the
     * next orders, in name order. Assignments are added, never removed. Everything not restored is listed.
     * @param {{ tags: unknown[], tagMap: Record<string, unknown>, overwrite: boolean }} backup
     */
    async restore({ tags, tagMap, overwrite }) {
        const definitions = {
            createdTagIds: /** @type {string[]} */ ([]),
            updatedTagIds: /** @type {string[]} */ ([]),
            invalidTags: /** @type {string[]} */ ([]),
            keptTags: /** @type {{ id: string, name: string, existingId: string }[]} */ ([]),
            namesTaken: /** @type {{ id: string, name: string }[]} */ ([]),
            unreadableTags: /** @type {{ id: string, name: string }[]} */ ([]),
        };
        /** @type {Map<string, string>} Backup id → the id its tag has here, where they differ. */
        const actualIds = new Map();
        /** @type {(Record<string, unknown> & { id: string, name: string })[]} */
        const valid = [];
        for (const raw of tags) {
            const tag = /** @type {any} */ (raw);
            if (!tag || typeof tag !== 'object' || Array.isArray(tag) || typeof tag.id !== 'string' || !tag.id || typeof tag.name !== 'string' || !tag.name) {
                definitions.invalidTags.push(String(JSON.stringify(raw)));
                continue;
            }
            valid.push(tag);
        }
        await this.writeDefinitions(LibraryTags.creationOrder(valid), async (source, batch) => {
            const { id, name } = source;
            const nameKey = tagNameKey(name);
            const { existing, gone } = await this.definitionTarget(id, name, nameKey !== '');
            const orderOf = (/** @type {Record<string, unknown>} */ t) => (Object.hasOwn(t, 'sort_order') ? tagDerivedColumns(t).sortOrder : null);
            if (existing) {
                if (existing.key !== id) actualIds.set(id, existing.key);
                if (!overwrite) {
                    definitions.keptTags.push({ id, name, existingId: existing.key });
                    return null;
                }
                const [old] = await this.definitions([existing.id]);
                /** @type {Record<string, unknown>} */
                const patch = { ...source };
                delete patch.id;
                const oldKey = typeof old?.name === 'string' ? tagNameKey(old.name) : '';
                if (existing.key === id && oldKey !== nameKey) {
                    const [holder] = await this.store.tagByNames([name]);
                    if (holder !== null && holder !== existing.id) {
                        delete patch.name;
                        definitions.namesTaken.push({ id, name });
                    }
                }
                // While moves queue, a sort_order is queued and the rest written (as edit() does).
                const queued = Object.hasOwn(patch, 'sort_order') && !batch.settled;
                const { sort_order: patchedOrder, ...rest } = patch;
                const merged = { ...old, ...(queued ? rest : patch), id: existing.key };
                if (JSON.stringify(merged) !== JSON.stringify(old)) definitions.updatedTagIds.push(existing.key);
                const names = [oldKey, typeof merged.name === 'string' ? tagNameKey(merged.name) : ''];
                return { tag: merged, names, ...(queued ? { queue: patchedOrder } : {}), bump: orderOf(patch) };
            }
            const newId = gone ? crypto.randomUUID() : id;
            if (newId !== id) actualIds.set(id, newId);
            const tag = { ...source, id: newId };
            const own = Object.hasOwn(tag, 'sort_order');
            if (!own) tag.sort_order = batch.next;
            definitions.createdTagIds.push(newId);
            return { tag, names: [nameKey], ...(own ? { queue: tag.sort_order } : {}), bump: orderOf(tag) };
        });
        /** @type {{ key: string, value: string }[]} */
        const invalidKeys = [];
        /** @type {Record<string, string[]>} */
        const toAssign = {};
        /** @type {Map<string, unknown[]>} */
        const notTagIds = new Map();
        for (const [key, value] of Object.entries(tagMap)) {
            if (!Array.isArray(value)) {
                invalidKeys.push({ key, value: String(JSON.stringify(value)) });
                continue;
            }
            const tagIds = [];
            const others = [];
            for (const tagId of value) {
                if (typeof tagId === 'string' && tagId !== '') tagIds.push(actualIds.get(tagId) ?? tagId);
                else others.push(tagId);
            }
            if (others.length > 0) notTagIds.set(key, others);
            if (tagIds.length > 0 || others.length > 0) toAssign[key] = tagIds;
        }
        const assigned = await this.assignMap(toAssign, 'tag backup restore');
        const missing = new Set(assigned.droppedKeys);
        /** @type {Map<string, unknown[]>} */
        const undefinedByKey = new Map(assigned.undefinedTagIds.map(u => [u.key, /** @type {unknown[]} */ (u.tagIds)]));
        for (const [key, others] of notTagIds) {
            if (!missing.has(key)) undefinedByKey.set(key, [...(undefinedByKey.get(key) ?? []), ...others]);
        }
        return {
            ...definitions,
            invalidKeys,
            missingKeys: assigned.droppedKeys,
            undefinedTagIds: [...undefinedByKey].map(([key, tagIds]) => ({ key, tagIds })),
            deletedTagIds: assigned.notAssigned,
            failedKeys: [],
        };
    }

    /**
     * Adds a `{ key: tagIds }` map's assignments (importTagMap() with its definitions required), IMPORT_BATCH keys a
     * commit, a pause between commits. A deleted tag is assigned as the live tag its merges lead to; one deleted with
     * none, or with no definition, isn't assigned.
     * @param {Record<string, unknown>} tagMap
     * @param {string} label Names the import in its warnings.
     * @returns {Promise<{ droppedKeys: string[], undefinedTagIds: { key: string, tagIds: string[] }[], notAssigned: { key: string, tagIds: string[] }[] }>}
     *   droppedKeys: neither a character nor a group; undefinedTagIds and notAssigned per known key.
     */
    async assignMap(tagMap, label) {
        /** @type {string[]} */
        const droppedKeys = [];
        /** @type {{ key: string, tagIds: string[] }[]} */
        const undefinedTagIds = [];
        /** @type {{ key: string, tagIds: string[] }[]} */
        const notAssigned = [];
        const entries = Object.entries(tagMap);
        for (let i = 0; i < entries.length; i += IMPORT_BATCH) {
            if (i > 0) await delay(IMPORT_PAUSE_MS);
            const batch = entries.slice(i, i + IMPORT_BATCH).filter(([key, value]) => {
                if (Array.isArray(value)) return true;
                console.warn(`[library-engine-tags] ${label}: tag_map entry ${key} is not a list, nothing imported for it: ${JSON.stringify(value)}`);
                return false;
            });
            const keys = batch.map(([key]) => key).filter(key => tagEntityTypeOf(key) !== null);
            await this.withEntities(keys, async (entities) => {
                const byKey = new Map(keys.map((k, n) => [k, entities[n]]));
                const tagKeys = [...new Set(batch.flatMap(([, ids]) => /** @type {string[]} */ (ids)))];
                const statuses = await this.status(tagKeys);
                const targets = [...new Set(statuses.flatMap(st => (st?.state === 'gone' && st.into !== undefined ? [st.into] : [])))];
                const targetStatus = new Map((await this.status(targets)).map((st, n) => [targets[n], st]));
                /** @type {Map<string, { id: bigint, key: string } | 'deleted' | 'undefined'>} */
                const resolved = new Map();
                tagKeys.forEach((k, n) => {
                    const st = statuses[n];
                    if (st?.state === 'live') resolved.set(k, { id: st.id, key: k });
                    else if (st?.state === 'gone' && st.into === undefined) resolved.set(k, 'deleted');
                    else if (st?.state === 'gone') {
                        const t = targetStatus.get(/** @type {string} */ (st.into));
                        resolved.set(k, t?.state === 'live' ? { id: t.id, key: /** @type {string} */ (st.into) } : 'undefined');
                    } else resolved.set(k, 'undefined');
                });
                const records = [];
                for (const [key, ids] of batch) {
                    const entity = byKey.get(key);
                    if (!entity) {
                        droppedKeys.push(key);
                        continue;
                    }
                    const dropped = [];
                    const missing = new Set();
                    const assign = new Map();
                    for (const k of /** @type {string[]} */ (ids)) {
                        const r = resolved.get(k);
                        if (r === 'deleted') dropped.push(k);
                        else if (r === 'undefined') missing.add(k);
                        else if (r) assign.set(r.key, r.id);
                    }
                    if (dropped.length > 0) {
                        notAssigned.push({ key, tagIds: dropped });
                        console.warn(`[library-engine-tags] Not assigned to ${key}: tag(s) deleted with no merge target: ${dropped.join(', ')}`);
                    }
                    if (missing.size > 0) undefinedTagIds.push({ key, tagIds: [...missing] });
                    records.push(...this.addRecords(entity, [...assign.values()]));
                }
                if (records.length > 0) await this.store.commit(records);
            });
        }
        return { droppedKeys, undefinedTagIds, notAssigned };
    }

    /**
     * migrateSettingsTagsIfNeeded() on the engine: imports settings' `tags` and `tag_map` from a legacy settings.json
     * not yet split, then from the key files settings/tags.json + settings/tag_map.json (tag-actions D33, D34). A
     * source is imported whole or not at all; what exists is skipped, so a rerun is safe. Imported key files leave
     * the settings store; the legacy file is never touched. Done once no source is left (TAG_META.settingsImported),
     * until restartSettingsImport(). A new store's first run decides the default tags (TAG_META.seedPending).
     * @param {import('./users.js').UserDirectoryList} directories
     */
    async importSettingsTags(directories) {
        const [done] = await this.store.meta([TAG_META.settingsImported]);
        if (done !== null) return;
        let sourceLeft = false;
        const seedCheck = { tagsKey: false, unreadable: /** @type {string[]} */ ([]) };
        const legacyPath = legacySettingsPath(directories);
        const legacy = readSettingsTagsSource(legacyPath);
        if (!('missing' in legacy)) {
            sourceLeft = true;
            const label = `settings tags import (${legacyPath})`;
            if ('error' in legacy) {
                seedCheck.unreadable.push(legacyPath);
                console.error(`[library-engine-tags] ${label}: could not read ${legacyPath}, nothing imported from it; retrying next boot: ${legacy.error}`);
            } else if (!legacy.value || typeof legacy.value !== 'object' || Array.isArray(legacy.value)) {
                console.warn(`[library-engine-tags] ${label}: ${legacyPath} is not an object, nothing imported from it.`);
            } else {
                if (Object.hasOwn(legacy.value, 'tags')) seedCheck.tagsKey = true;
                await this.importSettingsSource(label, /** @type {object} */ (legacy.value));
            }
        }
        const dir = settingsDirPath(directories);
        const keyFiles = [path.join(dir, 'tags.json'), path.join(dir, 'tag_map.json')].map(filePath => ({ filePath, read: readSettingsTagsSource(filePath) }));
        const present = keyFiles.filter(file => !('missing' in file.read));
        if (!('missing' in keyFiles[0].read)) seedCheck.tagsKey = true;
        if (present.length > 0) {
            const label = `settings tags import (${present.map(file => file.filePath).join(' + ')})`;
            const unreadable = present.filter(file => 'error' in file.read);
            if (unreadable.length > 0) {
                sourceLeft = true;
                seedCheck.unreadable.push(...unreadable.map(file => file.filePath));
                for (const file of unreadable) {
                    console.error(`[library-engine-tags] ${label}: could not read ${file.filePath}, nothing imported from the key files; retrying next boot: ${/** @type {{ error: string }} */ (file.read).error}`);
                }
            } else {
                /** @type {{ tags?: unknown, tag_map?: unknown }} */
                const source = {};
                const [tagsFile, tagMapFile] = keyFiles;
                if ('value' in tagsFile.read) source.tags = tagsFile.read.value;
                if ('value' in tagMapFile.read) source.tag_map = tagMapFile.read.value;
                await this.importSettingsSource(label, source);
                for (const file of present) {
                    if (!moveImportedSettingsFile(file.filePath, /** @type {{ text: string }} */ (file.read).text)) sourceLeft = true;
                }
            }
        }
        await this.seedDefaultTagsIfPending(seedCheck);
        if (!sourceLeft) {
            await this.store.commit([{ kind: 'metaValue', key: TAG_META.settingsImported, json: JSON.stringify(Date.now()) }]);
            // A restore may have written a source after it was looked for, and cleared the mark before it was set.
            if ([legacyPath, ...keyFiles.map(file => file.filePath)].some(filePath => fs.existsSync(filePath))) await this.restartSettingsImport();
        }
    }

    /** Makes importSettingsTags() read the settings sources again on its next run. */
    async restartSettingsImport() {
        await this.store.commit([{ kind: 'metaValue', key: TAG_META.settingsImported }]);
    }

    /** Marks a store just created, so its first settings tags import decides the default tags. */
    async markSeedPending() {
        await this.store.commit([{ kind: 'metaValue', key: TAG_META.seedPending, json: 'true' }]);
    }

    /**
     * One settings source: its `tags` (when it has the key), created as create() creates them, every tag not
     * created listed; then its `tag_map`, leaving out assignments of tags with no definition.
     * @param {string} label
     * @param {{ tags?: unknown, tag_map?: unknown }} source Only own keys are read.
     */
    async importSettingsSource(label, source) {
        if (Object.hasOwn(source, 'tags')) {
            if (Array.isArray(source.tags)) {
                /** @type {string[]} */
                const skipped = [];
                /** @type {Record<string, unknown>[]} */
                const valid = [];
                for (const raw of source.tags) {
                    const tag = /** @type {any} */ (raw);
                    if (!tag || typeof tag !== 'object' || Array.isArray(tag) || typeof tag.id !== 'string' || !tag.id) skipped.push(`  ${JSON.stringify(raw)}: not a tag with a non-empty string id`);
                    else valid.push(tag);
                }
                const created = new Set();
                await this.writeDefinitions(LibraryTags.creationOrder(valid), async (source, batch) => {
                    const id = /** @type {string} */ (source.id);
                    const [status] = await this.status([id]);
                    if (status?.state === 'gone') {
                        skipped.push(`  ${id}: deleted`);
                        return null;
                    }
                    if (status?.state === 'live' || created.has(id)) {
                        skipped.push(`  ${id}: already exists`);
                        return null;
                    }
                    created.add(id);
                    const tag = /** @type {Record<string, unknown> & { id: string }} */ ({ ...source });
                    const own = Object.hasOwn(tag, 'sort_order');
                    if (!own) tag.sort_order = batch.next;
                    return { tag, names: [], ...(own ? { queue: tag.sort_order } : {}), bump: tagDerivedColumns(tag).sortOrder };
                });
                if (skipped.length > 0) console.warn(`[library-engine-tags] ${label}: ${skipped.length} tag(s) not imported:\n${skipped.join('\n')}`);
            } else {
                console.warn(`[library-engine-tags] ${label}: tags is not a list, no tag imported from it: ${JSON.stringify(source.tags)}`);
            }
        }
        if (!Object.hasOwn(source, 'tag_map')) return;
        const tagMap = source.tag_map;
        if (!tagMap || typeof tagMap !== 'object' || Array.isArray(tagMap)) {
            console.warn(`[library-engine-tags] ${label}: tag_map is not an object, no assignment imported from it: ${JSON.stringify(tagMap)}`);
            return;
        }
        const imported = await this.assignMap(/** @type {Record<string, unknown>} */ (tagMap), label);
        if (imported.droppedKeys.length > 0) {
            console.warn(`[library-engine-tags] ${label}: ${imported.droppedKeys.length} tag_map key(s) matched neither a known character nor a known group, not imported: ${imported.droppedKeys.join(', ')}`);
        }
        if (imported.undefinedTagIds.length > 0) {
            console.warn(`[library-engine-tags] ${label}: tag ids with no tag definition, not assigned:\n${imported.undefinedTagIds.map(u => `  ${u.key}: ${u.tagIds.join(', ')}`).join('\n')}`);
        }
    }

    /**
     * On a store marked new, decides whether it gets upstream's default tags, and clears the mark in the same commit:
     * it gets them when every settings source was read and none has a `tags` key. They get the next orders in name
     * order, as upstream shows them.
     * @param {{ tagsKey: boolean, unreadable: string[] }} settings
     */
    async seedDefaultTagsIfPending(settings) {
        await this.lane(async () => {
            const [pending] = await this.store.meta([TAG_META.seedPending]);
            if (pending === null) return;
            const records = [{ kind: 'metaValue', key: TAG_META.seedPending }];
            if (!settings.tagsKey && settings.unreadable.length === 0) {
                let next = await this.nextOrder();
                for (const tag of LibraryTags.creationOrder(DEFAULT_TAG_NAMES.map(name => ({ id: crypto.randomUUID(), name, create_date: Date.now() })))) {
                    records.push(...(await this.lib.tagRecords({ ...tag, sort_order: next++ })).records);
                }
            }
            await this.store.commit(records);
            if (settings.unreadable.length > 0) {
                console.warn(`[library-engine-tags] This store is new, but the default tags were not added, because these settings files could not be read, so whether they have tags is unknown: ${settings.unreadable.join(', ')}`);
            }
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
