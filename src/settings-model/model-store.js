import { POSITION_GAP, historyWrites, itemField, pushAll, valueRecords } from '../entity-values.js';
import { NO_PLACEHOLDER, PART_LISTS, REF_ARRAYS, REF_LISTS, REF_VALUES, refKey } from './refs.js';

const EMPTY_LIST = 'list:';

const DEFINED = 'model:defined';

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {import('../entity-values.js').StoredEntity} StoredEntity
 * @typedef {import('../library-engine.js').LibraryEngine} LibraryEngine
 */

/**
 * @param {EntityDraft[]} drafts
 */
function flatten(drafts) {
    /** @type {EntityDraft[]} */
    const all = [];
    const visit = (/** @type {EntityDraft} */ d) => {
        all.push(d);
        for (const [list, items] of Object.entries(d.lists ?? {})) {
            if (PART_LISTS[d.type]?.[list] === undefined) continue;
            for (const part of items) visit(/** @type {EntityDraft} */ (part));
        }
    };
    drafts.forEach(visit);
    return all;
}

/**
 * @param {StoredEntity} entity
 */
function withoutPartLists(entity) {
    const parts = PART_LISTS[entity.type] ?? {};
    return { ...entity, items: entity.items.filter(i => parts[i.list] === undefined) };
}

/**
 * @param {LibraryEngine} lib
 * @param {EntityDraft[]} drafts
 * @param {{ actor?: import('../world-info-engine.js').Actor | null, warnings?: string[], refs?: [number, string][], extra?: (ids: Map<string, bigint>, stamp: () => import('../entity-values.js').Stamp) => Promise<object[]> }} [options]
 * @returns {Promise<Map<string, bigint>>}
 */
export async function writeDrafts(lib, drafts, { actor = null, warnings = [], refs = [], extra } = {}) {
    const all = flatten(drafts);
    const idKey = (/** @type {number} */ type, /** @type {string} */ key) => `${type}:${key}`;
    /** @type {object[]} */
    const records = [];
    /** @type {Map<string, bigint>} */
    const ids = new Map();
    /** @type {Map<string, StoredEntity>} */
    const stored = new Map();

    const found = await lib.store.libraryIds(all.map(d => [d.type, d.key]));
    const existing = await lib.entities(found);
    all.forEach((d, i) => {
        const id = found[i] ?? lib.nextId++;
        ids.set(idKey(d.type, d.key), id);
        if (existing[i]) stored.set(idKey(d.type, d.key), existing[i]);
        else records.push({ kind: 'entityCreate', entity: id, type: d.type, key: d.key, added: Date.now() });
    });

    /** @type {[number, string][]} */
    const targets = [];
    const noteRef = (/** @type {number} */ type, /** @type {unknown} */ name) => {
        if (typeof name === 'string' && name !== '' && !ids.has(idKey(type, refKey(type, name)))) targets.push([type, refKey(type, name)]);
    };
    for (const [type, name] of refs) noteRef(type, name);
    for (const d of all) {
        for (const [field, type] of Object.entries(REF_VALUES[d.type] ?? {})) noteRef(type, d.values[field]);
        for (const [field, type] of Object.entries(REF_ARRAYS[d.type] ?? {})) {
            if (Array.isArray(d.values[field])) /** @type {unknown[]} */ (d.values[field]).forEach(item => noteRef(type, item));
        }
        for (const [list, type] of Object.entries(REF_LISTS[d.type] ?? {})) (d.lists?.[list] ?? []).forEach(item => noteRef(type, item));
    }
    if (targets.length) {
        const targetIds = await lib.store.libraryIds(targets);
        targets.forEach(([type, key], i) => {
            if (ids.has(idKey(type, key))) return;
            if (targetIds[i] === null && NO_PLACEHOLDER.has(type)) {
                warnings.push(`a ref to ${key} (type ${type}) names nothing; dropped`);
                return;
            }
            const id = targetIds[i] ?? lib.nextId++;
            if (targetIds[i] === null) records.push({ kind: 'entityCreate', entity: id, type, key, added: Date.now() });
            ids.set(idKey(type, key), id);
        });
    }
    const refText = (/** @type {number} */ type, /** @type {unknown} */ name) => {
        if (typeof name !== 'string' || name === '') return name;
        const id = ids.get(idKey(type, refKey(type, name)));
        return id === undefined ? undefined : String(id);
    };

    const stamp = await lib.stamper(actor, records);
    const writes = historyWrites(stamp);
    for (const d of all) {
        const id = /** @type {bigint} */ (ids.get(idKey(d.type, d.key)));
        const was = stored.get(idKey(d.type, d.key)) ?? null;
        /** @type {Map<number | string, { text?: string, json?: string }>} */
        const values = new Map([[DEFINED, { text: '' }]]);
        for (const [field, raw] of Object.entries(d.values)) {
            const refType = REF_VALUES[d.type]?.[field];
            const arrayType = REF_ARRAYS[d.type]?.[field];
            const value = refType !== undefined ? refText(refType, raw)
                : arrayType !== undefined && Array.isArray(raw) ? raw.map(item => refText(arrayType, item)).filter(item => item !== undefined)
                    : raw;
            if (value === undefined) continue;
            values.set(field, typeof value === 'string' ? { text: value } : { json: JSON.stringify(value) });
        }
        /** @type {Map<number, string[]>} */
        const lists = new Map();
        for (const [list, items] of Object.entries(d.lists ?? {})) {
            if (items.length === 0) values.set(`${EMPTY_LIST}${list}`, { json: '[]' });
            if (PART_LISTS[d.type]?.[list] !== undefined) continue;
            const refType = REF_LISTS[d.type]?.[list];
            const texts = items.map(item => (refType !== undefined ? refText(refType, item) : item));
            lists.set(Number(list), /** @type {string[]} */ (texts.filter(text => text !== undefined)).map(String));
        }
        pushAll(records, valueRecords(id, was ? /** @type {StoredEntity} */ (withoutPartLists(was)) : null, { values, lists }, writes));

        for (const [list, partType] of Object.entries(PART_LISTS[d.type] ?? {})) {
            const listNumber = Number(list);
            const parts = /** @type {EntityDraft[]} */ (d.lists?.[list] ?? []);
            const partIds = parts.map(p => /** @type {bigint} */ (ids.get(idKey(partType, p.key))));
            const before = (was?.items ?? []).filter(i => i.list === listNumber);
            const keep = new Set(partIds.map(String));
            for (const item of before) {
                if (keep.has(String(item.item))) continue;
                records.push({ kind: 'histPlace', entity: id, list: listNumber, item: item.item, ...stamp() });
                records.push({ kind: 'histEntityDelete', entity: BigInt(item.item), ...stamp() });
            }
            const order = [...before].sort((a, b) => a.position - b.position).map(i => String(i.item));
            if (order.length === partIds.length && order.every((item, i) => item === String(partIds[i]))) continue;
            const top = before.reduce((m, i) => Math.max(m, i.position), 0);
            partIds.forEach((partId, i) => records.push(writes.place(id, listNumber, /** @type {any} */ (partId), top + POSITION_GAP * (i + 1))));
        }
    }
    if (extra) pushAll(records, await extra(ids, stamp));
    await lib.store.commit(records);
    return ids;
}

/**
 * @param {LibraryEngine} lib
 * @param {number} type
 * @param {string} key
 * @returns {Promise<EntityDraft | null>}
 */
export async function readDraft(lib, type, key) {
    const [id] = await lib.ids(type, [key]);
    if (id === null) return null;
    const [entity] = await lib.entities([id]);
    return entity && isDefined(entity) ? draftOf(lib, entity) : null;
}

/**
 * @param {StoredEntity} entity
 */
function isDefined(entity) {
    return entity.values.some(v => v.field === DEFINED);
}

/**
 * @param {LibraryEngine} lib
 * @param {StoredEntity} entity
 * @returns {Promise<EntityDraft>}
 */
async function draftOf(lib, entity) {
    const parts = PART_LISTS[entity.type] ?? {};
    const refValues = REF_VALUES[entity.type] ?? {};
    const refArrays = REF_ARRAYS[entity.type] ?? {};
    const refLists = REF_LISTS[entity.type] ?? {};
    /** @type {Map<number, string>} */
    const itemTexts = new Map();
    /** @type {Record<string, unknown>} */
    const values = {};
    /** @type {bigint[]} */
    const refIds = [];
    /** @type {number[]} */
    const emptyLists = [];
    for (const v of entity.values) {
        if (typeof v.field === 'number' && v.field >= 1024) {
            itemTexts.set(v.field, /** @type {string} */ (v.text));
            continue;
        }
        const value = v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json));
        if (v.field === DEFINED) continue;
        if (typeof v.field === 'string' && v.field.startsWith(EMPTY_LIST)) {
            emptyLists.push(Number(v.field.slice(EMPTY_LIST.length)));
            continue;
        }
        values[String(v.field)] = value;
        if (refValues[v.field] !== undefined && typeof value === 'string' && value !== '') refIds.push(BigInt(value));
        if (refArrays[v.field] !== undefined && Array.isArray(value)) value.forEach(id => refIds.push(BigInt(id)));
    }
    /** @type {Record<number, { item: number, position: number }[]>} */
    const byList = {};
    for (const item of entity.items) (byList[item.list] ??= []).push(item);
    for (const list of Object.keys(byList)) byList[list].sort((a, b) => a.position - b.position);
    for (const [list, items] of Object.entries(byList)) {
        if (refLists[list] === undefined) continue;
        for (const i of items) refIds.push(BigInt(itemTexts.get(itemField(Number(list), i.item)) ?? '0'));
    }
    const keyOf = await keysOf(lib, refIds);
    for (const field of Object.keys(refValues)) {
        if (typeof values[field] === 'string' && values[field] !== '') values[field] = keyOf.get(String(values[field]));
    }
    for (const field of Object.keys(refArrays)) {
        if (Array.isArray(values[field])) values[field] = /** @type {string[]} */ (values[field]).map(id => keyOf.get(id)).filter(key => key !== undefined);
    }
    /** @type {Record<number, (string | EntityDraft)[]>} */
    const lists = {};
    for (const [list, items] of Object.entries(byList)) {
        if (parts[list] !== undefined) {
            const partEntities = await lib.entities(items.map(i => BigInt(i.item)));
            lists[list] = await Promise.all(partEntities.filter(e => e && isDefined(e)).map(e => draftOf(lib, /** @type {StoredEntity} */ (e))));
            continue;
        }
        const texts = items.map(i => itemTexts.get(itemField(Number(list), i.item)) ?? '');
        lists[list] = refLists[list] !== undefined ? texts.map(t => /** @type {string} */ (keyOf.get(t))) : texts;
    }
    for (const list of emptyLists) lists[list] ??= [];
    return { type: entity.type, key: entity.key, values, ...(Object.keys(lists).length ? { lists } : {}) };
}

/**
 * @param {LibraryEngine} lib
 * @param {bigint[]} ids
 * @returns {Promise<Map<string, string>>}
 */
export async function keysOf(lib, ids) {
    if (ids.length === 0) return new Map();
    const unique = [...new Map(ids.map(id => [String(id), id])).values()];
    const keys = await lib.store.libraryKeys(unique);
    return new Map(unique.map((id, i) => [String(id), keys[i]?.key]));
}

/**
 * @param {LibraryEngine} lib
 * @param {number} type
 * @param {{ after?: string | null, limit: number }} page
 * @returns {Promise<{ drafts: EntityDraft[], more: boolean, last: string | null }>}
 */
export async function readCatalog(lib, type, { after = null, limit }) {
    const { entities, more } = await lib.store.libraryOfType(type, after, limit);
    const stored = await lib.entities(entities.map(e => e.id));
    const drafts = await Promise.all(stored.filter(e => e && isDefined(e)).map(e => draftOf(lib, /** @type {StoredEntity} */ (e))));
    return { drafts, more, last: entities.length ? entities[entities.length - 1].key : after };
}
