import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { POSITION_GAP, itemField, pushAll, valueRecords } from './entity-values.js';
import { foldName } from './fold-name.js';
import { FIELD, TYPE } from './library-codes.js';
import { userStore } from './user-stores.js';
import { placeEntries } from './world-info-engine.js';

/**
 * A user's saved views of the character list, in the user's store: a name and the view object the page lists by
 * (public/scripts/character-view.js), in the user's own order.
 *
 * The views are the items of the view list's (`TYPE.viewList`, key '') list 0, in place order; a view is keyed by its
 * UUID. Each of a view's known leaves is its own value, the tag lists are lists, each condition is an entity in the
 * view's list 0 and each range one in its list 1; the view's unknown top-level keys are one JSON value. null, '', {}
 * and [] are the same as a missing key: nothing is stored for them, and they read back missing. A tag a view names
 * that was merged into another reads as that one (deduplicated within its list); the stored key stays.
 */

/** Emits `changed` (the user's root) when a user's saved views changed. */
export const savedViewsEvents = new EventEmitter();
savedViewsEvents.setMaxListeners(0);

/** Longest view name and view object a saved view keeps. */
export const SAVED_VIEW_NAME_MAX = 200;
export const SAVED_VIEW_JSON_MAX = 64 * 1024;
/** Most views one list read answers. */
export const SAVED_VIEWS_PAGE_MAX = 200;
/** Views read per step while a `contains` list read looks for matching names. */
const NAME_SCAN_PAGE = 200;

/** Field codes of the saved view types, one space for all of them. */
const F = Object.freeze({
    text: 42,
    tagMode: 43,
    fav: 44,
    group: 45,
    folderCase: 46,
    sortField: 47,
    sortOrder: 48,
    sortSeed: 49,
    tieField: 50,
    tieOrder: 51,
    tieSeed: 52,
    other: 53,
    conditionField: 54,
    conditionValue: 55,
    conditionNegated: 56,
    rangeField: 57,
    rangeMin: 58,
    rangeMax: 59,
});

/** A view's lists: its conditions, its ranges (items: their entities), its tag keys (items: texts). */
const LIST = Object.freeze({ conditions: 0, ranges: 1, include: 2, exclude: 3 });
/** The view list's list of views. */
const VIEWS = 0;

/** A view's leaves of a fixed shape, by path: [field, kind]. */
const SORT_LEAVES = /** @type {const} */ ([['field', 'string'], ['order', 'string'], ['seed', 'number']]);
const SORT_CODES = /** @type {const} */ ([F.sortField, F.sortOrder, F.sortSeed]);
const TIE_CODES = /** @type {const} */ ([F.tieField, F.tieOrder, F.tieSeed]);

/**
 * @typedef {{ id: string, name: string, view: Record<string, unknown> }} SavedView
 * @typedef {{ field?: string, value?: string, op: 'contains' | 'not_contains' }} Condition
 */

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a value means the same as a missing key. */
const isEmpty = (/** @type {unknown} */ v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(/** @type {object} */ (v)).length === 0);

/**
 * @param {Record<string, unknown>} o
 * @param {string} key
 * @param {unknown} value
 */
function setOwn(o, key, value) {
    Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A view as it is stored and read back: what means the same as missing left out. What doesn't fit the view's shape
 * is left out too and named in `problems`, one line each.
 * @param {unknown} view
 * @returns {{ view: Record<string, unknown>, problems: string[] }}
 */
export function canonicalView(view) {
    /** @type {string[]} */
    const problems = [];
    /** @type {Record<string, unknown>} */
    const out = {};
    if (!isPlainObject(view)) return { view: out, problems: ['view: not an object'] };
    const v = /** @type {Record<string, unknown>} */ (view);
    /**
     * A leaf of `kind` at `path`, or undefined when it is empty or doesn't fit.
     * @param {unknown} x
     * @param {'string' | 'number' | 'boolean'} kind
     * @param {string} path
     */
    const leaf = (x, kind, path) => {
        if (isEmpty(x)) return undefined;
        if (typeof x !== kind) {
            problems.push(`${path}: not a ${kind}`);
            return undefined;
        }
        return x;
    };
    /**
     * The keys of an object at `path` but `known`, each a problem.
     * @param {Record<string, unknown>} o
     * @param {readonly string[]} known
     * @param {string} path
     */
    const unknownKeys = (o, known, path) => {
        for (const k of Object.keys(o)) if (!known.includes(k)) problems.push(`${path}.${k}: not a key a view has`);
    };
    /**
     * A sort object at `path` (`sort` or `sort.tie`).
     * @param {unknown} x
     * @param {string} path
     * @param {boolean} withTie
     */
    const sortOf = (x, path, withTie) => {
        if (isEmpty(x)) return undefined;
        if (!isPlainObject(x)) {
            problems.push(`${path}: not an object`);
            return undefined;
        }
        const o = /** @type {Record<string, unknown>} */ (x);
        unknownKeys(o, withTie ? ['field', 'order', 'seed', 'tie'] : ['field', 'order', 'seed'], path);
        /** @type {Record<string, unknown>} */
        const s = {};
        for (const [k, kind] of SORT_LEAVES) {
            const got = leaf(o[k], kind, `${path}.${k}`);
            if (got !== undefined) s[k] = got;
        }
        if (withTie) {
            const tie = sortOf(o.tie, `${path}.tie`, false);
            if (tie !== undefined) s.tie = tie;
        }
        return isEmpty(s) ? undefined : s;
    };
    /** @type {Record<string, unknown>} */
    const other = {};
    for (const key of Object.keys(v)) {
        const x = v[key];
        switch (key) {
            case 'text':
            case 'folderCase': {
                const got = leaf(x, 'string', key);
                if (got !== undefined) out[key] = got;
                break;
            }
            case 'fav':
            case 'group': {
                const got = leaf(x, 'boolean', key);
                if (got !== undefined) out[key] = got;
                break;
            }
            case 'tags': {
                if (isEmpty(x)) break;
                if (!isPlainObject(x)) {
                    problems.push('tags: not an object');
                    break;
                }
                const o = /** @type {Record<string, unknown>} */ (x);
                unknownKeys(o, ['include', 'exclude', 'mode'], 'tags');
                /** @type {Record<string, unknown>} */
                const tags = {};
                for (const list of ['include', 'exclude']) {
                    const items = o[list];
                    if (isEmpty(items)) continue;
                    if (!Array.isArray(items)) problems.push(`tags.${list}: not a list`);
                    else if (!items.every(t => typeof t === 'string')) problems.push(`tags.${list}: an item isn't a string`);
                    else tags[list] = [...items];
                }
                const mode = leaf(o.mode, 'string', 'tags.mode');
                if (mode !== undefined) tags.mode = mode;
                if (!isEmpty(tags)) out.tags = tags;
                break;
            }
            case 'sort': {
                const sort = sortOf(x, 'sort', true);
                if (sort !== undefined) out.sort = sort;
                break;
            }
            case 'ranges': {
                if (isEmpty(x)) break;
                if (!isPlainObject(x)) {
                    problems.push('ranges: not an object');
                    break;
                }
                const o = /** @type {Record<string, unknown>} */ (x);
                /** @type {Record<string, unknown>} */
                const ranges = {};
                for (const field of Object.keys(o)) {
                    const r = o[field];
                    const path = `ranges.${field}`;
                    if (isEmpty(r)) continue;
                    if (!isPlainObject(r)) {
                        problems.push(`${path}: not an object`);
                        continue;
                    }
                    const ro = /** @type {Record<string, unknown>} */ (r);
                    unknownKeys(ro, ['min', 'max'], path);
                    /** @type {Record<string, unknown>} */
                    const range = {};
                    for (const end of ['min', 'max']) {
                        const got = leaf(ro[end], 'number', `${path}.${end}`);
                        if (got !== undefined) range[end] = got;
                    }
                    if (!isEmpty(range)) setOwn(ranges, field, range);
                }
                if (!isEmpty(ranges)) out.ranges = ranges;
                break;
            }
            case 'conditions': {
                if (isEmpty(x)) break;
                if (!Array.isArray(x)) {
                    problems.push('conditions: not a list');
                    break;
                }
                const conditions = [];
                for (const [i, c] of x.entries()) {
                    const why = conditionProblem(c);
                    if (why !== null) {
                        problems.push(`conditions[${i}]: ${why}`);
                        continue;
                    }
                    const o = /** @type {Record<string, unknown>} */ (c);
                    /** @type {Record<string, unknown>} */
                    const cond = {};
                    if (o.field !== '') cond.field = o.field;
                    if (o.value !== '') cond.value = o.value;
                    cond.op = o.op;
                    conditions.push(cond);
                }
                if (conditions.length > 0) out.conditions = conditions;
                break;
            }
            default:
                setOwn(other, key, x);
        }
    }
    for (const k of Object.keys(other)) setOwn(out, k, other[k]);
    return { view: out, problems };
}

/**
 * Why a condition doesn't fit, or null when it does.
 * @param {unknown} c
 * @returns {string | null}
 */
function conditionProblem(c) {
    if (!isPlainObject(c)) return 'not an object';
    const o = /** @type {Record<string, unknown>} */ (c);
    const extra = Object.keys(o).filter(k => k !== 'field' && k !== 'value' && k !== 'op');
    if (extra.length > 0) return `has keys a condition doesn't have (${extra.join(', ')})`;
    if (typeof o.field !== 'string') return 'field is not a string';
    if (typeof o.value !== 'string') return 'value is not a string';
    if (o.op !== 'contains' && o.op !== 'not_contains') return 'op is not contains or not_contains';
    return null;
}

/**
 * The names of a view's top-level keys that aren't a view's, in the canonical view.
 * @param {Record<string, unknown>} view
 */
const otherKeys = view => Object.keys(view).filter(k => !['text', 'folderCase', 'fav', 'group', 'tags', 'sort', 'ranges', 'conditions'].includes(k));

const put = (/** @type {unknown} */ v) => (typeof v === 'string' ? { text: v } : { json: JSON.stringify(v) });

/**
 * A canonical view's own values and tag lists (its conditions and ranges are entities).
 * @param {string} name
 * @param {Record<string, unknown>} view
 */
function ownValues(name, view) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    if (name !== '') values.set(FIELD.name, { text: name });
    if (view.text !== undefined) values.set(F.text, put(view.text));
    if (view.fav !== undefined) values.set(F.fav, put(view.fav));
    if (view.group !== undefined) values.set(F.group, put(view.group));
    if (view.folderCase !== undefined) values.set(F.folderCase, put(view.folderCase));
    const tags = /** @type {Record<string, unknown> | undefined} */ (view.tags);
    if (tags?.mode !== undefined) values.set(F.tagMode, put(tags.mode));
    if (tags?.include !== undefined) lists.set(LIST.include, /** @type {string[]} */ (tags.include));
    if (tags?.exclude !== undefined) lists.set(LIST.exclude, /** @type {string[]} */ (tags.exclude));
    const sort = /** @type {Record<string, unknown> | undefined} */ (view.sort);
    const tie = /** @type {Record<string, unknown> | undefined} */ (sort?.tie);
    SORT_LEAVES.forEach(([k], i) => {
        if (sort?.[k] !== undefined) values.set(SORT_CODES[i], put(sort[k]));
        if (tie?.[k] !== undefined) values.set(TIE_CODES[i], put(tie[k]));
    });
    const others = otherKeys(view);
    if (others.length > 0) {
        /** @type {Record<string, unknown>} */
        const o = {};
        for (const k of others) setOwn(o, k, view[k]);
        values.set(F.other, { json: JSON.stringify(o) });
    }
    return { values, lists };
}

/**
 * A condition's values.
 * @param {Record<string, unknown>} c
 */
function conditionValues(c) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    if (c.field !== undefined) values.set(F.conditionField, put(c.field));
    if (c.value !== undefined) values.set(F.conditionValue, put(c.value));
    values.set(F.conditionNegated, put(c.op === 'not_contains'));
    return { values, lists: new Map() };
}

/**
 * A range's values.
 * @param {string} field
 * @param {Record<string, unknown>} r
 */
function rangeValues(field, r) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    if (field !== '') values.set(F.rangeField, put(field));
    if (r.min !== undefined) values.set(F.rangeMin, put(r.min));
    if (r.max !== undefined) values.set(F.rangeMax, put(r.max));
    return { values, lists: new Map() };
}

/**
 * @typedef {object} StoredView A view as stored, for writing over it.
 * @property {bigint} id
 * @property {string} key Its UUID.
 * @property {import('./entity-values.js').StoredEntity} entity Its own values and tag lists.
 * @property {{ entity: import('./entity-values.js').StoredEntity, position: number }[]} conditions In place order.
 * @property {Map<string, { entity: import('./entity-values.js').StoredEntity, position: number }>} ranges By card field.
 */

/**
 * Reads views as stored.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {bigint[]} ids
 * @returns {Promise<(StoredView | null)[]>}
 */
export async function storedViews(lib, ids) {
    const entities = await lib.entities(ids);
    /** @type {bigint[]} */
    const parts = [];
    for (const e of entities) {
        for (const it of e?.items ?? []) if (it.list === LIST.conditions || it.list === LIST.ranges) parts.push(BigInt(it.item));
    }
    const partEntities = await lib.entities(parts);
    const byId = new Map(parts.map((id, i) => [id, partEntities[i]]));
    return entities.map((e) => {
        if (!e || e.type !== TYPE.view) return null;
        /** @type {StoredView['conditions']} */
        const conditions = [];
        /** @type {StoredView['ranges']} */
        const ranges = new Map();
        for (const it of [...e.items].sort((a, b) => a.position - b.position)) {
            if (it.list !== LIST.conditions && it.list !== LIST.ranges) continue;
            const part = byId.get(BigInt(it.item));
            if (!part) continue;
            if (it.list === LIST.conditions) conditions.push({ entity: part, position: it.position });
            else ranges.set(part.key.slice(part.key.indexOf(':') + 1), { entity: part, position: it.position });
        }
        const own = { ...e, items: e.items.filter(it => it.list === LIST.include || it.list === LIST.exclude) };
        return { id: e.id, key: e.key, entity: own, conditions, ranges };
    });
}

/**
 * The values of an entity by field.
 * @param {import('./entity-values.js').StoredEntity} e
 */
function valuesOf(e) {
    /** @type {Map<number | string, unknown>} */
    const out = new Map();
    for (const v of e.values) {
        if (typeof v.field === 'number' && v.field >= 1024) continue;
        out.set(v.field, v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json)));
    }
    return out;
}

/**
 * A stored view's name and view object, its tag keys as stored.
 * @param {StoredView} s
 * @returns {{ name: string, view: Record<string, unknown> }}
 */
export function assembleView(s) {
    const values = valuesOf(s.entity);
    /** @type {Record<string, unknown>} */
    const view = {};
    if (values.has(F.text)) view.text = values.get(F.text);
    if (s.conditions.length > 0) {
        view.conditions = s.conditions.map(({ entity }) => {
            const c = valuesOf(entity);
            /** @type {Record<string, unknown>} */
            const out = {};
            if (c.has(F.conditionField)) out.field = c.get(F.conditionField);
            if (c.has(F.conditionValue)) out.value = c.get(F.conditionValue);
            out.op = c.get(F.conditionNegated) === true ? 'not_contains' : 'contains';
            return out;
        });
    }
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    const texts = new Map(s.entity.values.filter(v => typeof v.field === 'number' && v.field >= 1024).map(v => [v.field, v.text ?? '']));
    for (const it of [...s.entity.items].sort((a, b) => a.position - b.position)) {
        if (!lists.has(it.list)) lists.set(it.list, []);
        lists.get(it.list)?.push(texts.get(itemField(it.list, it.item)) ?? '');
    }
    /** @type {Record<string, unknown>} */
    const tags = {};
    if (lists.has(LIST.include)) tags.include = lists.get(LIST.include);
    if (lists.has(LIST.exclude)) tags.exclude = lists.get(LIST.exclude);
    if (values.has(F.tagMode)) tags.mode = values.get(F.tagMode);
    if (!isEmpty(tags)) view.tags = tags;
    if (values.has(F.fav)) view.fav = values.get(F.fav);
    if (values.has(F.group)) view.group = values.get(F.group);
    if (s.ranges.size > 0) {
        /** @type {Record<string, unknown>} */
        const ranges = {};
        for (const [field, { entity }] of s.ranges) {
            const r = valuesOf(entity);
            /** @type {Record<string, unknown>} */
            const range = {};
            if (r.has(F.rangeMin)) range.min = r.get(F.rangeMin);
            if (r.has(F.rangeMax)) range.max = r.get(F.rangeMax);
            setOwn(ranges, field, range);
        }
        view.ranges = ranges;
    }
    /** @type {Record<string, unknown>} */
    const sort = {};
    /** @type {Record<string, unknown>} */
    const tie = {};
    SORT_LEAVES.forEach(([k], i) => {
        if (values.has(SORT_CODES[i])) sort[k] = values.get(SORT_CODES[i]);
        if (values.has(TIE_CODES[i])) tie[k] = values.get(TIE_CODES[i]);
    });
    if (!isEmpty(tie)) sort.tie = tie;
    if (!isEmpty(sort)) view.sort = sort;
    if (values.has(F.folderCase)) view.folderCase = values.get(F.folderCase);
    const other = /** @type {Record<string, unknown> | undefined} */ (values.get(F.other));
    if (other) for (const k of Object.keys(other)) setOwn(view, k, other[k]);
    return { name: /** @type {string} */ (values.get(FIELD.name) ?? ''), view };
}

/**
 * Stored views as the user reads them: each tag key merged into another reads as that one, then each tag list
 * keeps a key's first occurrence.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {StoredView[]} stored
 * @returns {Promise<SavedView[]>}
 */
async function readAs(lib, stored) {
    const assembled = stored.map(s => ({ id: s.key, ...assembleView(s) }));
    /** @type {Set<string>} */
    const keys = new Set();
    for (const { view } of assembled) {
        const tags = /** @type {Record<string, string[]> | undefined} */ (view.tags);
        for (const k of [...(tags?.include ?? []), ...(tags?.exclude ?? [])]) keys.add(k);
        if (typeof view.folderCase === 'string') keys.add(view.folderCase);
    }
    const asked = [...keys];
    const statuses = await lib.tags.status(asked);
    /** @type {Map<string, string>} */
    const into = new Map();
    statuses.forEach((s, i) => {
        if (s?.state === 'gone' && s.into !== undefined) into.set(asked[i], s.into);
    });
    const as = (/** @type {string} */ k) => into.get(k) ?? k;
    for (const { view } of assembled) {
        const tags = /** @type {Record<string, unknown> | undefined} */ (view.tags);
        for (const list of ['include', 'exclude']) {
            if (tags?.[list]) tags[list] = [...new Set(/** @type {string[]} */ (tags[list]).map(as))];
        }
        if (typeof view.folderCase === 'string') view.folderCase = as(view.folderCase);
    }
    return assembled;
}

/**
 * The records turning a stored view (none for a new one) into `name` and the canonical `view`.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {bigint} id
 * @param {string} key The view's UUID.
 * @param {StoredView | null} s
 * @param {string} name
 * @param {Record<string, unknown>} view
 * @returns {object[]}
 */
function viewRecords(lib, id, key, s, name, view) {
    const records = valueRecords(id, s?.entity ?? null, ownValues(name, view));
    pushAll(records, conditionRecords(lib, id, key, s?.conditions ?? [], /** @type {Record<string, unknown>[]} */ (view.conditions ?? [])));
    pushAll(records, rangeRecords(lib, id, key, s?.ranges ?? new Map(), /** @type {Record<string, Record<string, unknown>>} */ (view.ranges ?? {})));
    return records;
}

/**
 * The records making a view's conditions `incoming`: conditions equal at both ends stay, those between are edited
 * in place, the rest added or deleted.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {bigint} view
 * @param {string} key
 * @param {StoredView['conditions']} before
 * @param {Record<string, unknown>[]} incoming
 */
function conditionRecords(lib, view, key, before, incoming) {
    const json = (/** @type {Record<string, unknown>} */ c) => JSON.stringify([c.field, c.value, c.op]);
    const was = before.map(x => json(assembleCondition(x.entity)));
    let head = 0;
    while (head < before.length && head < incoming.length && was[head] === json(incoming[head])) head++;
    let tail = 0;
    while (tail < before.length - head && tail < incoming.length - head && was[before.length - 1 - tail] === json(incoming[incoming.length - 1 - tail])) tail++;
    /** @type {[string, Record<string, unknown>, import('./entity-values.js').StoredEntity | null][]} */
    const keyed = incoming.map((c, j) => {
        const i = j < head ? j : j >= incoming.length - tail ? before.length - (incoming.length - j) : j < before.length - tail ? j : -1;
        if (i >= 0) return [String(before[i].entity.id), c, before[i].entity];
        return [String(lib.nextId++), c, null];
    });
    const records = [];
    const kept = new Set(keyed.map(([k]) => k));
    for (const x of before) {
        if (kept.has(String(x.entity.id))) continue;
        records.push({ kind: 'itemDelete', entity: view, list: LIST.conditions, item: x.entity.id });
        records.push({ kind: 'entityDelete', entity: x.entity.id });
    }
    const positions = placeEntries(keyed.map(([k]) => k), new Map(before.map(x => [String(x.entity.id), x.position])));
    for (const [k, c, had] of keyed) {
        const cid = BigInt(k);
        if (!had) records.push({ kind: 'entityCreate', entity: cid, type: TYPE.condition, key: `${key}:${cid}`, added: Date.now() });
        pushAll(records, valueRecords(cid, had, conditionValues(c)));
        const position = positions.get(k);
        if (position !== undefined) records.push({ kind: 'itemPlace', entity: view, list: LIST.conditions, item: cid, position });
    }
    return records;
}

/** @param {import('./entity-values.js').StoredEntity} e */
function assembleCondition(e) {
    const c = valuesOf(e);
    return { field: c.get(F.conditionField), value: c.get(F.conditionValue), op: c.get(F.conditionNegated) === true ? 'not_contains' : 'contains' };
}

/**
 * The records making a view's ranges `incoming`, each kept by its card field.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {bigint} view
 * @param {string} key
 * @param {StoredView['ranges']} before
 * @param {Record<string, Record<string, unknown>>} incoming
 */
function rangeRecords(lib, view, key, before, incoming) {
    const fields = Object.keys(incoming);
    const records = [];
    for (const [field, x] of before) {
        if (Object.hasOwn(incoming, field)) continue;
        records.push({ kind: 'itemDelete', entity: view, list: LIST.ranges, item: x.entity.id });
        records.push({ kind: 'entityDelete', entity: x.entity.id });
    }
    const positions = placeEntries(fields, new Map([...before].map(([f, x]) => [f, x.position])));
    for (const field of fields) {
        const had = before.get(field);
        const rid = had ? had.entity.id : lib.nextId++;
        if (!had) records.push({ kind: 'entityCreate', entity: rid, type: TYPE.range, key: `${key}:${field}`, added: Date.now() });
        pushAll(records, valueRecords(rid, had?.entity ?? null, rangeValues(field, incoming[field])));
        const position = positions.get(field);
        if (position !== undefined) records.push({ kind: 'itemPlace', entity: view, list: LIST.ranges, item: rid, position });
    }
    return records;
}

/**
 * The user's view list, or null before their first view.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @returns {Promise<bigint | null>}
 */
export async function viewHolder(lib) {
    const [id] = await lib.ids(TYPE.viewList, ['']);
    return id;
}

/**
 * The records creating a view at `position` of the view list (`holder`: null to create the list too).
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {{ holder: bigint | null, key: string, name: string, view: Record<string, unknown>, position: number }} v
 * @returns {{ records: object[], holder: bigint }}
 */
export function createRecords(lib, { holder, key, name, view, position }) {
    const records = [];
    const list = holder ?? lib.nextId++;
    if (holder === null) records.push({ kind: 'entityCreate', entity: list, type: TYPE.viewList, key: '', added: Date.now() });
    const id = lib.nextId++;
    records.push({ kind: 'entityCreate', entity: id, type: TYPE.view, key, added: Date.now() });
    pushAll(records, viewRecords(lib, id, key, null, name, view));
    records.push({ kind: 'itemPlace', entity: list, list: VIEWS, item: id, position });
    return { records, holder: list };
}

/**
 * Places in the view list, up to `limit`, after the place `after` or before the place `before` (nearest first).
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {bigint} holder
 * @param {{ after?: number | null, before?: number, limit: number }} at
 * @returns {Promise<{ entries: { id: bigint, position: number }[], more: boolean }>}
 */
export function viewPlaces(lib, holder, { after = null, before, limit }) {
    return lib.store.worldRead('entries', { book: holder, ...(after === null ? {} : { after }), ...(before === undefined ? {} : { before }), limit });
}

/** @param {{ root: string }} directories */
async function libOf(directories) {
    return (await userStore(directories)).lib;
}

/** @param {number} limit */
const pageSize = limit => Math.max(1, Math.min(Math.trunc(limit) || SAVED_VIEWS_PAGE_MAX, SAVED_VIEWS_PAGE_MAX));

/**
 * One page of the user's saved views in their order, those whose names hold `contains` when it is given.
 * @param {{ root: string }} directories
 * @param {{ contains?: string, after?: number | null, limit?: number }} [options] `after`: the place of the last
 * view of the page before.
 * @returns {Promise<{ views: SavedView[], more: boolean, last: number | null }>} `last`: the place of the page's
 * last view.
 */
export async function listSavedViews(directories, { contains = '', after = null, limit = SAVED_VIEWS_PAGE_MAX } = {}) {
    const lib = await libOf(directories);
    const holder = await viewHolder(lib);
    if (holder === null) return { views: [], more: false, last: null };
    const take = pageSize(limit);
    const needle = foldName(String(contains).trim());
    /** @type {{ id: bigint, position: number }[]} */
    let kept = [];
    let more = false;
    if (!needle) {
        const page = await viewPlaces(lib, holder, { after, limit: take });
        kept = page.entries;
        more = page.more;
    } else {
        let from = after;
        for (;;) {
            const page = await viewPlaces(lib, holder, { after: from, limit: NAME_SCAN_PAGE });
            const names = await lib.entities(page.entries.map(e => e.id), { fields: [FIELD.name], lists: [] });
            for (const [i, e] of page.entries.entries()) {
                const name = names[i]?.values.find(v => v.field === FIELD.name)?.text ?? '';
                if (!foldName(name).includes(needle)) continue;
                if (kept.length === take) {
                    more = true;
                    break;
                }
                kept.push(e);
            }
            if (more || !page.more || page.entries.length === 0) break;
            from = page.entries[page.entries.length - 1].position;
        }
    }
    const stored = (await storedViews(lib, kept.map(e => e.id))).filter(s => s !== null);
    return { views: await readAs(lib, /** @type {StoredView[]} */ (stored)), more, last: kept.length ? kept[kept.length - 1].position : null };
}

/**
 * One saved view, or null when no view has the id.
 * @param {{ root: string }} directories
 * @param {string} id
 * @returns {Promise<SavedView | null>}
 */
export async function getSavedView(directories, id) {
    const lib = await libOf(directories);
    const [vid] = await lib.ids(TYPE.view, [id]);
    if (vid === null) return null;
    const [s] = await storedViews(lib, [vid]);
    return s ? (await readAs(lib, [s]))[0] : null;
}

/**
 * Runs `write` after every earlier write to the user's saved views has settled.
 * @template T
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {() => Promise<T>} write
 */
const lane = (lib, write) => lib.serialized(TYPE.viewList, '', write);

/**
 * Saves a new view after the user's others.
 * @param {{ root: string }} directories
 * @param {{ name: string, view: object }} params `view` canonical (`canonicalView()`).
 * @returns {Promise<SavedView>}
 */
export async function createSavedView(directories, { name, view }) {
    const lib = await libOf(directories);
    const key = crypto.randomUUID();
    const canonical = /** @type {Record<string, unknown>} */ (view);
    await lane(lib, async () => {
        const holder = await viewHolder(lib);
        const last = holder === null ? null : (await lib.store.worldRead('numbers', { book: holder })).lastPosition;
        const { records } = createRecords(lib, { holder, key, name, view: canonical, position: (last ?? 0) + POSITION_GAP });
        await lib.store.commit(records);
    });
    savedViewsEvents.emit('changed', directories.root);
    return { id: key, name, view: canonical };
}

/**
 * Changes one view's name or view object. Writes only what differs.
 * @param {{ root: string }} directories
 * @param {string} id
 * @param {{ name?: string, view?: object }} change `view` canonical (`canonicalView()`).
 * @returns {Promise<SavedView | null>} null when no view has the id.
 */
export async function changeSavedView(directories, id, { name, view }) {
    const lib = await libOf(directories);
    const done = await lane(lib, async () => {
        const [vid] = await lib.ids(TYPE.view, [id]);
        if (vid === null) return null;
        const [s] = await storedViews(lib, [vid]);
        if (!s) return null;
        const was = assembleView(s);
        const next = { name: name ?? was.name, view: /** @type {Record<string, unknown>} */ (view ?? was.view) };
        const records = viewRecords(lib, vid, id, s, next.name, next.view);
        if (records.length > 0) await lib.store.commit(records);
        return { result: { id, ...next }, wrote: records.length > 0 };
    });
    if (done === null) return null;
    if (done.wrote) savedViewsEvents.emit('changed', directories.root);
    return done.result;
}

/**
 * Deletes one view.
 * @param {{ root: string }} directories
 * @param {string} id
 * @returns {Promise<boolean>} false when no view had the id.
 */
export async function deleteSavedView(directories, id) {
    const lib = await libOf(directories);
    const deleted = await lane(lib, async () => {
        const [vid] = await lib.ids(TYPE.view, [id]);
        const holder = await viewHolder(lib);
        if (vid === null || holder === null) return false;
        const [e] = await lib.entities([vid], { fields: [], lists: [LIST.conditions, LIST.ranges] });
        if (!e) return false;
        const records = [];
        for (const it of e.items) {
            if (it.list !== LIST.conditions && it.list !== LIST.ranges) continue;
            records.push({ kind: 'itemDelete', entity: vid, list: it.list, item: BigInt(it.item) });
            records.push({ kind: 'entityDelete', entity: BigInt(it.item) });
        }
        records.push({ kind: 'itemDelete', entity: holder, list: VIEWS, item: vid });
        records.push({ kind: 'entityDelete', entity: vid });
        await lib.store.commit(records);
        return true;
    });
    if (deleted) savedViewsEvents.emit('changed', directories.root);
    return deleted;
}

/**
 * Moves one view to just before or just after another: halfway between its new neighbours, or, when no place is
 * free there, every view placed again in the new order above the highest place.
 * @param {{ root: string }} directories
 * @param {string} id
 * @param {{ anchor: string, side: 'before' | 'after' }} where
 * @returns {Promise<'moved' | 'unchanged' | 'missing'>} 'missing' when either view doesn't exist.
 */
export async function moveSavedView(directories, id, { anchor, side }) {
    const lib = await libOf(directories);
    /** @type {'moved' | 'unchanged' | 'missing'} */
    const outcome = await lane(lib, async () => {
        const holder = await viewHolder(lib);
        const [vid, aid] = await lib.ids(TYPE.view, [id, anchor]);
        if (holder === null || vid === null || aid === null) return 'missing';
        if (vid === aid) return 'unchanged';
        const [at, from] = await lib.store.worldRead('itemPlaces', { entity: holder, list: VIEWS, items: [aid, vid] });
        if (at === null || from === null) return 'missing';
        // The anchor's nearest two on that side: the first that isn't the moving view is the new neighbour.
        const near = (await viewPlaces(lib, holder, side === 'after' ? { after: at, limit: 2 } : { before: at, limit: 2 })).entries;
        if (near[0]?.id === vid) return 'unchanged';
        const neighbour = near.find(e => e.id !== vid);
        let position;
        if (side === 'after') {
            position = neighbour ? Math.floor((at + neighbour.position) / 2) : at + POSITION_GAP;
            if (!(position > at && (!neighbour || position < neighbour.position))) position = null;
        } else {
            const low = neighbour ? neighbour.position : 0;
            position = Math.floor((low + at) / 2);
            if (!(position > low && position < at)) position = null;
        }
        if (position !== null) {
            await lib.store.commit([{ kind: 'itemPlace', entity: holder, list: VIEWS, item: vid, position }]);
            return 'moved';
        }
        // No place free: every view again, in the new order, above the highest place.
        /** @type {{ id: bigint, position: number }[]} */
        const all = [];
        let after = null;
        for (;;) {
            const page = await viewPlaces(lib, holder, { after, limit: 1000 });
            pushAll(all, page.entries);
            if (!page.more || page.entries.length === 0) break;
            after = page.entries[page.entries.length - 1].position;
        }
        const order = all.filter(e => e.id !== vid).map(e => e.id);
        const ai = order.indexOf(aid);
        order.splice(side === 'after' ? ai + 1 : ai, 0, vid);
        const top = all.length ? all[all.length - 1].position : 0;
        await lib.store.commit(order.map((item, i) => ({ kind: 'itemPlace', entity: holder, list: VIEWS, item, position: top + POSITION_GAP * (i + 1) })));
        return 'moved';
    });
    if (outcome === 'moved') savedViewsEvents.emit('changed', directories.root);
    return outcome;
}
