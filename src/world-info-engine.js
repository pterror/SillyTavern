import { jsonHash } from '../public/scripts/hash-utils.js';
import { POSITION_GAP, historyWrites, itemField, pushAll, valueRecords } from './entity-values.js';
import { LINKS, storedLinks } from './character-links.js';
import { TYPE } from './library-codes.js';
import { bookKey } from './world-info-keys.js';

const ENTRY_KEYS = Object.freeze([
    'uid', 'key', 'keysecondary', 'comment', 'content', 'constant', 'vectorized', 'selective', 'selectiveLogic',
    'addMemo', 'order', 'position', 'disable', 'ignoreBudget', 'excludeRecursion', 'preventRecursion',
    'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt',
    'matchScenario', 'matchCreatorNotes', 'delayUntilRecursion', 'probability', 'useProbability', 'depth', 'outletName',
    'group', 'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring',
    'automationId', 'role', 'sticky', 'cooldown', 'delay', 'characterFilterNames', 'characterFilterTags',
    'characterFilterExclude', 'triggers', 'displayIndex', 'characterFilter', 'extensions',
    'keys', 'secondary_keys', 'insertion_order', 'enabled', 'case_sensitive', 'name', 'priority', 'id',
]);
const ENTRY_CODE_BASE = 100;
const EXTENSION_KEYS = Object.freeze([
    'position', 'exclude_recursion', 'prevent_recursion', 'delay_until_recursion', 'display_index', 'probability',
    'useProbability', 'depth', 'selectiveLogic', 'outlet_name', 'group', 'group_override', 'group_weight',
    'scan_depth', 'case_sensitive', 'match_whole_words', 'use_group_scoring', 'automation_id', 'role', 'vectorized',
    'sticky', 'cooldown', 'delay', 'match_persona_description', 'match_character_description',
    'match_character_personality', 'match_character_depth_prompt', 'match_scenario', 'match_creator_notes',
    'triggers', 'ignore_budget',
]);
const EXTENSION_CODE_BASE = 160;
const EXTENSION_CODE = new Map(EXTENSION_KEYS.map((k, i) => [k, EXTENSION_CODE_BASE + i]));
const EXTENSION_NAME = new Map(EXTENSION_KEYS.map((k, i) => [EXTENSION_CODE_BASE + i, k]));
const EXTENSION_MARK = '\u0001';
const KEY_ESCAPE = '\u0002';
const EXTENSION_ORDER = 99;
const WHOLE = 96;
const NO_UID = 97;
const ORDER = 98;
const DEFINED = 41;
const UID = ENTRY_CODE_BASE;

const ENTRY_CODE = new Map(ENTRY_KEYS.map((k, i) => [k, ENTRY_CODE_BASE + i]));
const EXTENSIONS = /** @type {number} */ (ENTRY_CODE.get('extensions'));
const ENTRY_NAME = new Map(ENTRY_KEYS.map((k, i) => [ENTRY_CODE_BASE + i, k]));
const ENTRY_LIST = new Map([['key', 0], ['keysecondary', 1], ['triggers', 2], ['keys', 3], ['secondary_keys', 4]]);
const ENTRY_LIST_NAME = new Map([...ENTRY_LIST].map(([k, v]) => [v, k]));

export const MAX_UID = 1_000_000;
const DISPLAY_INDEX = /** @type {number} */ (ENTRY_CODE.get('displayIndex'));

/**
 * @typedef {object} Actor
 * @property {string} user
 * @property {string | null} [session]
 */

export const SLOT = Object.freeze({ characterBook: 'c', originalData: 'o' });

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} v
 * @returns {v is { entries: object[] }}
 */
export function isEntryList(v) {
    return isPlainObject(v) && Array.isArray(/** @type {any} */ (v).entries) && /** @type {any} */ (v).entries.every(isPlainObject);
}

/**
 * @param {unknown} book
 * @returns {boolean}
 */
export function isCardBookCopy(book) {
    const original = isPlainObject(book) ? /** @type {any} */ (book).originalData : undefined;
    return isPlainObject(original) && Array.isArray(original.entries);
}

/**
 * @param {Record<string, unknown>} o
 * @param {string} key
 * @param {unknown} value
 */
function setOwn(o, key, value) {
    Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * @param {string[]} keys
 * @param {string[]} canonical
 * @returns {string | null}
 */
function orderValue(keys, canonical) {
    if (keys.every((k, i) => k === canonical[i])) return null;
    const place = new Map(canonical.map((k, i) => [k, i]));
    return keys.map(k => String.fromCharCode(0x20 + /** @type {number} */ (place.get(k)))).join('');
}

/**
 * @param {string[]} canonical
 * @param {string | undefined} order
 */
function ordered(canonical, order) {
    if (order === undefined || order.length !== canonical.length) return canonical;
    return [...order].map(c => canonical[c.charCodeAt(0) - 0x20]);
}

function entryCanonical(/** @type {string[]} */ keys) {
    const known = keys.filter(k => ENTRY_CODE.has(k)).sort((a, b) => /** @type {number} */ (ENTRY_CODE.get(a)) - /** @type {number} */ (ENTRY_CODE.get(b)));
    const other = keys.filter(k => !ENTRY_CODE.has(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [...known, ...other];
}

function extensionCanonical(/** @type {string[]} */ keys) {
    const known = keys.filter(k => EXTENSION_CODE.has(k)).sort((a, b) => /** @type {number} */ (EXTENSION_CODE.get(a)) - /** @type {number} */ (EXTENSION_CODE.get(b)));
    const other = keys.filter(k => !EXTENSION_CODE.has(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [...known, ...other];
}

const ownKeyField = (/** @type {string} */ k) => (k.startsWith(EXTENSION_MARK) || k.startsWith(KEY_ESCAPE) ? KEY_ESCAPE + k : k);

function bookCanonical(/** @type {string[]} */ keys) {
    return [...keys.filter(k => k !== 'entries').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ...(keys.includes('entries') ? ['entries'] : [])];
}

const put = (/** @type {unknown} */ v) => (typeof v === 'string' ? { text: v } : { json: JSON.stringify(v) });

/**
 * @param {unknown} entry
 * @param {string} key
 * @param {boolean} owned
 */
export function entryValues(entry, key, owned) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    if (!isPlainObject(entry)) {
        values.set(WHOLE, { json: JSON.stringify(entry) ?? 'null' });
        return { values, lists };
    }
    const o = /** @type {Record<string, unknown>} */ (entry);
    const keys = Object.keys(o).filter(k => o[k] !== undefined);
    for (const k of keys) {
        const v = o[k];
        if (k === 'uid') {
            if (owned || !(typeof v === 'number' && String(v) === key)) values.set(UID, { json: JSON.stringify(v) });
            continue;
        }
        const list = ENTRY_LIST.get(k);
        if (list !== undefined && Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string')) {
            lists.set(list, v);
            continue;
        }
        if (k === 'extensions' && isPlainObject(v)) {
            const ext = /** @type {Record<string, unknown>} */ (v);
            const extKeys = Object.keys(ext).filter(x => ext[x] !== undefined);
            values.set(EXTENSIONS, { json: '' });
            for (const x of extKeys) values.set(EXTENSION_CODE.get(x) ?? EXTENSION_MARK + x, put(ext[x]));
            const extOrder = orderValue(extKeys, extensionCanonical(extKeys));
            if (extOrder !== null) values.set(EXTENSION_ORDER, { text: extOrder });
            continue;
        }
        values.set(ENTRY_CODE.get(k) ?? ownKeyField(k), put(v));
    }
    if (!owned && !keys.includes('uid')) values.set(NO_UID, { json: '' });
    const order = orderValue(keys, entryCanonical(keys));
    if (order !== null) values.set(ORDER, { text: order });
    return { values, lists };
}

/**
 * @param {import('./entity-values.js').StoredEntity} e
 * @param {boolean} owned
 */
export function entryObject(e, owned) {
    const key = e.key.slice(e.key.indexOf(':') + 1);
    /** @type {Map<string, unknown>} */
    const found = new Map();
    let order;
    let extOrder;
    let noUid = false;
    /** @type {Map<string, unknown> | null} */
    let ext = null;
    /** @type {Map<string, unknown>} */
    const extFound = new Map();
    /** @type {Map<number, { text?: string, json?: string }>} */
    const items = new Map();
    for (const v of e.values) {
        if (typeof v.field === 'number' && v.field >= 1024) {
            items.set(v.field, v);
            continue;
        }
        if (v.field === WHOLE) return JSON.parse(/** @type {string} */ (v.json));
        if (v.field === ORDER) {
            order = v.text;
            continue;
        }
        if (v.field === NO_UID) {
            noUid = true;
            continue;
        }
        if (v.field === EXTENSION_ORDER) {
            extOrder = v.text;
            continue;
        }
        const value = () => (v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json)));
        if (v.field === EXTENSIONS && v.json === '') {
            ext = extFound;
            found.set('extensions', null);
            continue;
        }
        const extName = typeof v.field === 'number' ? EXTENSION_NAME.get(v.field) : v.field.startsWith(EXTENSION_MARK) ? v.field.slice(1) : undefined;
        if (extName !== undefined) {
            extFound.set(extName, value());
            continue;
        }
        const name = typeof v.field === 'number' ? ENTRY_NAME.get(v.field) : v.field.startsWith(KEY_ESCAPE) ? v.field.slice(1) : v.field;
        if (name === undefined) continue;
        found.set(name, value());
    }
    if (ext !== null) {
        /** @type {Record<string, unknown>} */
        const o = {};
        for (const k of ordered(extensionCanonical([...extFound.keys()]), extOrder)) setOwn(o, k, extFound.get(k));
        found.set('extensions', o);
    }
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    for (const { list, item } of [...e.items].sort((a, b) => a.position - b.position)) {
        if (!lists.has(list)) lists.set(list, []);
        lists.get(list)?.push(items.get(1024 + item * 8 + list)?.text ?? '');
    }
    for (const [list, texts] of lists) {
        const name = ENTRY_LIST_NAME.get(list);
        if (name !== undefined) found.set(name, texts);
    }
    if (!owned && !noUid && !found.has('uid')) found.set('uid', Number(key));
    const keys = ordered(entryCanonical([...found.keys()]), order);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of keys) setOwn(out, k, found.get(k));
    return out;
}

/**
 * @param {Record<string, unknown>} book
 * @param {boolean} defined
 */
function bookValues(book, defined) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    const keys = Object.keys(book).filter(k => book[k] !== undefined);
    for (const k of keys) {
        if (k === 'entries') continue;
        if (k === 'originalData' && defined && isEntryList(book[k])) continue;
        values.set(k, put(book[k]));
    }
    const order = orderValue(keys, bookCanonical(keys));
    if (order !== null) values.set(ORDER, { text: order });
    if (defined) values.set(DEFINED, { json: '' });
    return { values, lists: new Map() };
}

/**
 * @typedef {object} StoredBook
 * @property {bigint} id
 * @property {import('./entity-values.js').StoredEntity | null} entity
 * @property {Map<string, { entity: import('./entity-values.js').StoredEntity, position: number }>} entries
 * @property {StoredBook | null} original
 */

export class WorldInfoEngine {
    /**
     * @param {import('./library-engine.js').LibraryEngine} lib
     */
    constructor(lib) {
        this.lib = lib;
        this.store = lib.store;
    }

    /**
     * @template T
     * @param {string[]} keys
     * @param {() => Promise<T>} write
     * @returns {Promise<T>}
     */
    lane(keys, write) {
        const sorted = [...new Set(keys)].sort();
        const run = (/** @type {number} */ i) => (i === sorted.length ? write() : this.lib.serialized(TYPE.book, sorted[i], () => run(i + 1)));
        return /** @type {Promise<T>} */ (run(0));
    }

    /**
     * @param {string} name
     * @returns {Promise<{ id: bigint, defined: boolean, key: string } | null>}
     */
    async find(name) {
        const key = bookKey(name);
        if (!key) return null;
        const [id] = await this.lib.ids(TYPE.book, [key]);
        if (id === null) return null;
        const [r] = await this.store.worldRead('resolved', { ids: [id] });
        return { id, defined: r?.id === id && r.defined, key };
    }

    /**
     * @param {Actor | null | undefined} actor
     * @param {object[]} records
     * @returns {Promise<() => import('./entity-values.js').Stamp>}
     */
    stamper(actor, records) {
        return this.lib.stamper(actor, records);
    }

    /**
     * @param {string} name
     */
    async exists(name) {
        return (await this.find(name))?.defined ?? false;
    }

    /**
     * @param {bigint} book
     * @returns {Promise<{ entity: import('./entity-values.js').StoredEntity, position: number }[]>}
     */
    async storedEntries(book) {
        /** @type {{ id: bigint, position: number }[]} */
        const places = [];
        let after;
        for (;;) {
            const page = await this.store.worldRead('entries', { book, after, limit: 1000 });
            pushAll(places, page.entries);
            if (!page.more) break;
            after = places[places.length - 1].position;
        }
        const entities = await this.lib.entities(places.map(p => p.id));
        return places.flatMap((p, i) => (entities[i] ? [{ entity: /** @type {import('./entity-values.js').StoredEntity} */ (entities[i]), position: p.position }] : []));
    }

    /**
     * @param {bigint} id
     * @param {boolean} world
     * @returns {Promise<StoredBook>}
     */
    async stored(id, world) {
        const [entity] = await this.lib.entities([id]);
        const entries = new Map((await this.storedEntries(id)).map(x => [x.entity.key.slice(x.entity.key.indexOf(':') + 1), x]));
        let original = null;
        if (world) {
            const [o] = await this.lib.ids(TYPE.ownedBook, [`${id}:${SLOT.originalData}`]);
            if (o !== null) original = await this.stored(o, false);
        }
        return { id, entity, entries, original };
    }

    /**
     * @param {StoredBook} s
     * @param {boolean} world
     * @returns {Record<string, unknown>}
     */
    assemble(s, world) {
        return assembleBook(s, world);
    }

    /**
     * @param {string} name
     */
    async read(name) {
        const found = await this.find(name);
        if (!found?.defined) return null;
        return this.assemble(await this.stored(found.id, true), true);
    }

    /**
     * @returns {Promise<{ file_id: string, name: string, extensions: object }[]>}
     */
    async list() {
        /** @type {{ id: bigint, key: string }[]} */
        const books = [];
        let after;
        for (;;) {
            const page = await this.store.worldRead('books', { after, limit: 1000 });
            pushAll(books, page.books);
            if (!page.more) break;
            after = books[books.length - 1].key;
        }
        const entities = await this.lib.entities(books.map(b => b.id));
        const rows = books.map((b, i) => {
            const values = new Map((entities[i]?.values ?? []).filter(v => typeof v.field === 'string').map(v => [v.field, v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json))]));
            const extensions = values.get('extensions');
            return {
                file_id: b.key,
                name: /** @type {string} */ (values.get('name') || b.key),
                extensions: typeof extensions === 'object' && extensions !== null ? extensions : {},
            };
        });
        return rows.sort((a, b) => `${a.file_id}.json`.localeCompare(`${b.file_id}.json`));
    }

    /**
     * @param {bigint} id
     * @param {StoredBook | null} s
     * @param {Record<string, unknown>} book
     * @param {{ world?: boolean, ownedKey?: string }} where
     * @param {() => import('./entity-values.js').Stamp} stamp
     * @returns {Promise<object[]>}
     */
    async bookRecords(id, s, book, { world = false, ownedKey } = {}, stamp) {
        const records = valueRecords(id, s?.entity ?? null, bookValues(book, world));
        if (!s?.entity && !world) records.push({ kind: 'entityCreate', entity: id, type: TYPE.ownedBook, key: ownedKey, added: Date.now() });
        const raw = book.entries;
        const stored = s?.entries ?? new Map();
        if (world) {
            const incoming = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
            pushAll(records, this.entryRecords(id, stored, Object.keys(incoming).filter(k => incoming[k] !== undefined).map(k => [k, incoming[k]]), false, stamp));
        } else {
            pushAll(records, this.listEntryRecords(id, stored, /** @type {unknown[]} */ (raw), stamp));
        }
        if (world) {
            const original = book.originalData;
            const [o] = s?.original ? [s.original.id] : [null];
            if (isEntryList(original)) {
                const oid = o ?? this.lib.nextId++;
                pushAll(records, (await this.bookRecords(oid, s?.original ?? null, /** @type {Record<string, unknown>} */ (original), { ownedKey: `${id}:${SLOT.originalData}` }, stamp)));
            } else if (s?.original) {
                pushAll(records, this.deleteRecords(s.original, stamp));
            }
        }
        return records;
    }

    /**
     * @param {bigint} book
     * @param {Map<string, { entity: import('./entity-values.js').StoredEntity, position: number }>} stored
     * @param {[string, unknown][]} incoming
     * @param {boolean} owned
     * @param {() => import('./entity-values.js').Stamp} stamp
     */
    entryRecords(book, stored, incoming, owned, stamp) {
        const records = [];
        const keys = new Set(incoming.map(([k]) => k));
        for (const [k, x] of stored) {
            if (!keys.has(k)) records.push({ kind: 'histEntityDelete', entity: x.entity.id, ...stamp() });
        }
        const positions = placeEntries(incoming.map(([k]) => k), new Map([...stored].map(([k, x]) => [k, x.position])));
        for (const [k, entry] of incoming) {
            const had = stored.get(k);
            const id = had ? had.entity.id : this.lib.nextId++;
            pushAll(records, valueRecords(id, had?.entity ?? null, entryValues(entry, k, owned), historyWrites(stamp)));
            if (!had) records.push({ kind: 'entityCreate', entity: id, type: TYPE.entry, key: `${book}:${k}`, added: 0 });
            const position = positions.get(k);
            if (position !== undefined) records.push({ kind: 'itemPlace', entity: book, list: 0, item: id, position });
            const index = isPlainObject(entry) && /** @type {any} */ (entry).displayIndex != null ? Number(/** @type {any} */ (entry).displayIndex) : undefined;
            if (!Object.is(index, had?.entity.entryIndex)) records.push({ kind: 'entryIndex', entry: id, book, ...(index === undefined ? {} : { index }) });
        }
        return records;
    }

    /**
     * @param {bigint} book
     * @param {Map<string, { entity: import('./entity-values.js').StoredEntity, position: number }>} stored
     * @param {unknown[]} incoming
     * @param {() => import('./entity-values.js').Stamp} stamp
     */
    listEntryRecords(book, stored, incoming, stamp) {
        const before = [...stored.entries()].sort((a, b) => a[1].position - b[1].position);
        const same = (/** @type {number} */ i, /** @type {number} */ j) => jsonHash(entryObject(before[i][1].entity, true)) === jsonHash(incoming[j]);
        let head = 0;
        while (head < before.length && head < incoming.length && same(head, head)) head++;
        let tail = 0;
        while (tail < before.length - head && tail < incoming.length - head && same(before.length - 1 - tail, incoming.length - 1 - tail)) tail++;
        let next = 1 + [...stored.keys()].map(Number).filter(Number.isInteger).reduce((m, n) => Math.max(m, n), -1);
        /** @type {[string, unknown][]} */
        const keyed = incoming.map((entry, j) => {
            if (j < head) return [before[j][0], entry];
            if (j >= incoming.length - tail) return [before[before.length - (incoming.length - j)][0], entry];
            if (j < before.length - tail) return [before[j][0], entry];
            return [String(next++), entry];
        });
        return this.entryRecords(book, stored, keyed, true, stamp);
    }

    /**
     * @param {StoredBook} s
     * @param {() => import('./entity-values.js').Stamp} stamp
     * @returns {object[]}
     */
    deleteRecords(s, stamp) {
        const records = [];
        for (const x of s.entries.values()) records.push({ kind: 'histEntityDelete', entity: x.entity.id, ...stamp() });
        if (s.original) pushAll(records, this.deleteRecords(s.original, stamp));
        if (s.entity?.type === TYPE.book) {
            for (const v of s.entity.values) records.push({ kind: 'valueDelete', entity: s.id, field: v.field });
        } else if (s.entity) {
            records.push({ kind: 'entityDelete', entity: s.id });
        }
        return records;
    }

    /**
     * @param {string} name
     * @param {Record<string, unknown>} data
     * @param {Actor | null} [actor]
     * @returns {Promise<{ records: number } | 'card copy'>}
     */
    write(name, data, actor = null) {
        if (isCardBookCopy(data)) return Promise.resolve('card copy');
        const key = bookKey(name);
        return this.lane([key], async () => {
            const [found] = await this.lib.ids(TYPE.book, [key]);
            const id = found ?? this.lib.nextId++;
            const s = found === null ? null : await this.stored(found, true);
            /** @type {object[]} */
            const keyed = [];
            const records = await this.bookRecords(id, s, data, { world: true }, await this.stamper(actor, keyed));
            if (found === null) records.unshift({ kind: 'entityCreate', entity: id, type: TYPE.book, key, added: Date.now() });
            if (records.length > 0) await this.store.commit([...keyed, ...records]);
            return { records: records.length };
        });
    }

    /**
     * @param {bigint} book
     * @returns {Promise<import('./settings-documents.js').BookChooser[]>}
     */
    async choosers(book) {
        /** @type {import('./settings-documents.js').BookChooser[]} */
        const found = [];
        let after;
        for (;;) {
            const page = await this.store.worldRead('choosers', { book, after, limit: 1000 });
            pushAll(found, page.choosers);
            if (!page.more) break;
            after = found[found.length - 1].holder;
        }
        return found;
    }

    /**
     * @param {string} name
     * @returns {Promise<{ characters: bigint[], trees: bigint[], choosers: import('./settings-documents.js').BookChooser[] } | null>}
     */
    delete(name) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const found = await this.find(name);
            if (!found?.defined) return null;
            /** @type {bigint[]} */
            const resolving = await this.store.worldRead('resolving', { book: found.id });
            const { records, changed } = await this.lib.unlinkRecords([...new Set(await this.linkers(found.id))], new Set(resolving));
            /** @type {Set<bigint>} */
            const trees = new Set();
            for (const book of resolving) {
                let after;
                for (;;) {
                    const page = await this.store.worldRead('chatLinks', { book, after, limit: 1000 });
                    for (const c of page.changes) {
                        records.push({ kind: 'stateUnset', id: c.id, ...(c.message === null ? { tree: c.tree } : { message: c.message }) });
                        trees.add(c.tree);
                    }
                    if (!page.more) break;
                    after = page.changes[page.changes.length - 1].id;
                }
            }
            const choosers = await this.choosers(found.id);
            for (const c of choosers) records.push({ kind: 'bookUnchoose', holder: c.holder, slot: c.slot, book: found.id });
            const s = await this.stored(found.id, true);
            pushAll(records, await this.eraseRecords(s));
            await this.store.commit(records);
            return { characters: changed, trees: [...trees], choosers };
        });
    }

    /**
     * @param {StoredBook} s
     * @returns {Promise<object[]>}
     */
    async eraseRecords(s) {
        const records = [...s.entries.values()].map(x => ({ kind: 'entityDelete', entity: x.entity.id }));
        let after;
        for (;;) {
            const page = await this.store.worldRead('deleted', { book: s.id, ...(after === undefined ? {} : { after }), limit: 1000 });
            for (const d of page.entries) records.push({ kind: 'entityDelete', entity: d.id });
            if (!page.more) break;
            after = page.entries[page.entries.length - 1].id;
        }
        if (s.original) pushAll(records, await this.eraseRecords(s.original));
        records.push({ kind: 'entityDelete', entity: s.id });
        return records;
    }

    /**
     * @param {string} name
     * @param {string} newName
     * @param {{ relink?: boolean, moved?: bigint[] }} [options]
     * @returns {Promise<'ok' | 'missing' | 'taken'>}
     */
    rename(name, newName, { relink = true, moved } = {}) {
        const [from, to] = [bookKey(name), bookKey(newName)];
        return this.lane([from, to], async () => {
            const found = await this.find(name);
            if (!found?.defined) return 'missing';
            if (from === to) return 'ok';
            const there = await this.find(newName);
            if (there?.defined) return 'taken';
            const [entity] = await this.lib.entities([found.id]);
            const update = { kind: 'entityUpdate', entity: found.id, type: TYPE.book, key: to, added: entity?.added ?? 0 };
            const records = there
                ? [{ kind: 'bookForward', from: there.id, into: found.id }, { kind: 'entityDelete', entity: there.id }, update]
                : [update];
            const own = await this.linkers(found.id);
            if (!relink && own.length) {
                const kept = this.lib.nextId++;
                records.push({ kind: 'entityCreate', entity: kept, type: TYPE.book, key: from, added: Date.now() });
                const resolving = new Set(await this.store.worldRead('resolving', { book: found.id }));
                for (let i = 0; i < own.length; i += 256) {
                    const linkers = await this.lib.entities(own.slice(i, i + 256), { fields: [], lists: [LINKS] });
                    for (const e of linkers) {
                        if (!e) continue;
                        const links = storedLinks(e).filter(l => resolving.has(l.book));
                        links.forEach((l, n) => records.push(n === 0
                            ? { kind: 'textValue', entity: e.id, field: itemField(LINKS, l.item), text: String(kept) }
                            : { kind: 'itemDelete', entity: e.id, list: LINKS, item: l.item }));
                    }
                }
            }
            const linkers = [...(relink ? own : []), ...(there ? await this.linkers(there.id) : [])];
            pushAll(records, await this.lib.identityRecords(linkers, to, relink ? [from, to] : [to]));
            await this.store.commit(records);
            if (moved && relink) pushAll(moved, own);
            return 'ok';
        });
    }

    /**
     * @param {{ id: bigint, entity: import('./entity-values.js').StoredEntity | null }[]} books
     * @returns {Promise<boolean[]>}
     */
    async cardCopies(books) {
        const owned = await this.lib.ids(TYPE.ownedBook, books.map(b => `${b.id}:${SLOT.originalData}`));
        return books.map((b, i) => {
            if (owned[i] !== null) return true;
            const v = b.entity?.values.find(x => x.field === 'originalData');
            if (!v) return false;
            return isCardBookCopy({ originalData: v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json)) });
        });
    }

    /**
     * @param {{ after?: string, limit?: number }} [page]
     * @returns {Promise<{ scanned: number, copies: string[], after: string | undefined, more: boolean }>}
     */
    async cardCopyPage({ after, limit = 1000 } = {}) {
        const page = await this.store.worldRead('books', { after, limit });
        /** @type {{ id: bigint, key: string }[]} */
        const books = page.books;
        const entities = await this.lib.entities(books.map(b => b.id));
        const copy = await this.cardCopies(books.map((b, i) => ({ id: b.id, entity: entities[i] })));
        return {
            scanned: books.length,
            copies: books.filter((_, i) => copy[i]).map(b => b.key),
            after: books.length ? books[books.length - 1].key : after,
            more: page.more,
        };
    }

    /**
     * @param {bigint} book
     * @returns {Promise<bigint[]>}
     */
    async linkers(book) {
        const out = [];
        for (const b of await this.store.worldRead('resolving', { book })) {
            let after;
            for (;;) {
                const page = await this.store.worldRead('linkers', { book: b, after, limit: 1000 });
                pushAll(out, page.ids);
                if (!page.more) break;
                after = page.ids[page.ids.length - 1];
            }
        }
        return out;
    }

    /**
     * @param {string} name
     * @param {{ uid: string | number, base_hash?: number | null, data?: object | null }[]} entryChanges
     * @param {{ key: string, base_hash?: number | null, value?: unknown }[]} fieldChanges
     * @param {Actor | null} [actor]
     * @returns {Promise<null | 'card copy' | { ok: true, entries: Record<string, object>, deleted: string[], fields: Record<string, unknown>, conflicts: object[] }>}
     */
    apply(name, entryChanges, fieldChanges, actor = null) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const found = await this.find(name);
            if (!found?.defined) return null;
            const book = found.id;
            const [bookEntity] = await this.lib.entities([book]);
            const copying = fieldChanges.some(c => c.key === 'originalData' && isCardBookCopy({ originalData: c.value }));
            if (copying && !(await this.cardCopies([{ id: book, entity: bookEntity }]))[0]) return 'card copy';
            const keys = entryChanges.map(c => String(c.uid));
            const ids = await this.lib.ids(TYPE.entry, keys.map(k => `${book}:${k}`));
            const entities = await this.lib.entities(ids);
            /** @type {Map<string, { entity: import('./entity-values.js').StoredEntity, position: number }>} */
            const touched = new Map();
            /** @type {Map<string, unknown>} */
            const writes = new Map();
            /** @type {object[]} */
            const records = [];
            const stamp = await this.stamper(actor, records);
            /** @type {Record<string, object>} */
            const stored = {};
            /** @type {string[]} */
            const deleted = [];
            /** @type {Record<string, unknown>} */
            const storedFields = {};
            /** @type {object[]} */
            const conflicts = [];
            /** @type {Map<string, object>} */
            const current = new Map();
            entities.forEach((e, i) => {
                if (e && !current.has(keys[i])) current.set(keys[i], entryObject(e, false));
            });
            const deletedUids = [];
            const gone = new Set();
            for (const [i, change] of entryChanges.entries()) {
                const k = keys[i];
                const cur = current.get(k);
                const next = isPlainObject(change.data) ? { ...change.data, uid: /** @type {any} */ (cur)?.uid ?? change.uid } : null;
                const currentHash = cur === undefined ? null : jsonHash(cur);
                if (currentHash === (next ? jsonHash(next) : null)) continue;
                if (currentHash !== (change.base_hash ?? null)) {
                    conflicts.push({ uid: k, current: cur ?? null });
                    continue;
                }
                const e = /** @type {import('./entity-values.js').StoredEntity | null} */ (entities[i]);
                if (e && !gone.has(k)) touched.set(k, { entity: e, position: 0 });
                const nextJson = next && JSON.parse(JSON.stringify(next));
                if (nextJson) {
                    current.set(k, nextJson);
                    stored[k] = nextJson;
                    writes.set(k, nextJson);
                } else {
                    current.delete(k);
                    if (touched.has(k)) records.push({ kind: 'histEntityDelete', entity: /** @type {any} */ (touched.get(k)).entity.id, ...stamp() });
                    touched.delete(k);
                    gone.add(k);
                    writes.delete(k);
                    deleted.push(k);
                    deletedUids.push(change.uid);
                }
            }
            if (writes.size > 0) {
                const numbers = await this.store.worldRead('numbers', { book });
                let last = numbers.lastPosition ?? 0;
                for (const [k, entry] of writes) {
                    const had = touched.get(k);
                    const id = had ? had.entity.id : this.lib.nextId++;
                    pushAll(records, valueRecords(id, had?.entity ?? null, entryValues(entry, k, false), historyWrites(stamp)));
                    if (!had) {
                        last += POSITION_GAP;
                        records.push({ kind: 'entityCreate', entity: id, type: TYPE.entry, key: `${book}:${k}`, added: 0 });
                        records.push({ kind: 'itemPlace', entity: book, list: 0, item: id, position: last });
                    }
                    const index = /** @type {any} */ (entry).displayIndex != null ? Number(/** @type {any} */ (entry).displayIndex) : undefined;
                    if (!Object.is(index, had?.entity.entryIndex)) records.push({ kind: 'entryIndex', entry: id, book, ...(index === undefined ? {} : { index }) });
                }
            }
            const changes = () => records.some(r => /** @type {any} */ (r).kind !== 'keyMap');
            if (fieldChanges.length === 0 && deletedUids.length === 0) {
                if (changes()) await this.store.commit(records);
                return { ok: true, entries: stored, deleted, fields: storedFields, conflicts };
            }
            const s = { id: book, entity: bookEntity, entries: new Map(), original: null };
            const [o] = await this.lib.ids(TYPE.ownedBook, [`${book}:${SLOT.originalData}`]);
            if (o !== null) s.original = await this.stored(o, false);
            const fields = this.assemble(/** @type {StoredBook} */ (s), true);
            const nextBook = { ...fields };
            let fieldsChanged = false;
            for (const change of fieldChanges) {
                const cur = fields[change.key];
                const next = change.value ?? undefined;
                const currentHash = cur === undefined ? null : jsonHash(cur);
                if (currentHash === (next === undefined ? null : jsonHash(next))) continue;
                if (currentHash !== (change.base_hash ?? null)) {
                    conflicts.push({ key: change.key, current: cur ?? null });
                    continue;
                }
                if (next === undefined) delete nextBook[change.key]; else setOwn(nextBook, change.key, next);
                storedFields[change.key] = next ?? null;
                fieldsChanged = true;
            }
            const original = /** @type {any} */ (nextBook.originalData);
            if (deletedUids.length > 0 && original && Array.isArray(original.entries)) {
                // eslint-disable-next-line eqeqeq
                const kept = original.entries.filter((/** @type {any} */ item) => !deletedUids.some(uid => item?.uid == uid));
                if (kept.length !== original.entries.length) {
                    nextBook.originalData = { ...original, entries: kept };
                    fieldsChanged = true;
                }
            }
            if (fieldsChanged) {
                pushAll(records, valueRecords(book, bookEntity, bookValues(nextBook, true)));
                const ob = nextBook.originalData;
                if (isEntryList(ob)) {
                    pushAll(records, (await this.bookRecords(s.original?.id ?? this.lib.nextId++, s.original, /** @type {Record<string, unknown>} */ (ob), { ownedKey: `${book}:${SLOT.originalData}` }, stamp)));
                } else if (s.original) {
                    pushAll(records, this.deleteRecords(s.original, stamp));
                }
            }
            if (changes()) await this.store.commit(records);
            return { ok: true, entries: stored, deleted, fields: storedFields, conflicts };
        });
    }

    /**
     * @param {string} name
     * @param {number} [uid]
     * @returns {Promise<{ entry: { uid: number } } | 'missing' | 'full'>}
     */
    createEntry(name, uid) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const found = await this.find(name);
            if (!found?.defined) return 'missing';
            const numbers = await this.store.worldRead('numbers', { book: found.id });
            const asked = uid === undefined ? null : (await this.lib.ids(TYPE.entry, [`${found.id}:${uid}`]))[0] === null ? uid : null;
            const at = asked ?? numbers.freeKey;
            if (at >= MAX_UID) return 'full';
            const id = this.lib.nextId++;
            await this.store.commit([
                { kind: 'entityCreate', entity: id, type: TYPE.entry, key: `${found.id}:${at}`, added: 0 },
                { kind: 'itemPlace', entity: found.id, list: 0, item: id, position: (numbers.lastPosition ?? 0) + POSITION_GAP },
            ]);
            return { entry: { uid: at } };
        });
    }

    /**
     * @param {string} name
     * @param {string | number} uid
     * @param {object} data
     * @param {Actor | null} [actor]
     * @returns {Promise<{ entry: object } | 'missing' | 'no entry'>}
     */
    editEntry(name, uid, data, actor = null) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const found = await this.find(name);
            if (!found?.defined) return 'missing';
            const k = String(uid);
            const [id] = await this.lib.ids(TYPE.entry, [`${found.id}:${k}`]);
            const [e] = id === null ? [null] : await this.lib.entities([id]);
            if (!e) return 'no entry';
            const entry = { ...data, uid: /** @type {any} */ (entryObject(e, false)).uid };
            /** @type {object[]} */
            const keyed = [];
            const records = valueRecords(e.id, e, entryValues(entry, k, false), historyWrites(await this.stamper(actor, keyed)));
            const index = /** @type {any} */ (entry).displayIndex != null ? Number(/** @type {any} */ (entry).displayIndex) : undefined;
            if (!Object.is(index, e.entryIndex)) records.push({ kind: 'entryIndex', entry: e.id, book: found.id, ...(index === undefined ? {} : { index }) });
            if (records.length > 0) await this.store.commit([...keyed, ...records]);
            return { entry };
        });
    }

    /**
     * @param {{ source: string, target: string, uid: string | number, deleteOriginal: boolean }} args
     * @param {Actor | null} [actor]
     * @returns {Promise<{ entry: object } | 'no source' | 'no target' | 'no entry' | 'full'>}
     */
    transplant({ source, target, uid, deleteOriginal }, actor = null) {
        return this.lane([bookKey(source), bookKey(target)], async () => {
            const [from, to] = [await this.find(source), await this.find(target)];
            if (!from?.defined) return 'no source';
            if (!to?.defined) return 'no target';
            const [id] = await this.lib.ids(TYPE.entry, [`${from.id}:${String(uid)}`]);
            const [e] = id === null ? [null] : await this.lib.entities([id]);
            if (!e) return 'no entry';
            const numbers = await this.store.worldRead('numbers', { book: to.id });
            if (numbers.freeKey >= MAX_UID) return 'full';
            const moved = /** @type {Record<string, unknown>} */ (entryObject(e, false));
            moved.uid = numbers.freeKey;
            moved.displayIndex = Math.max(-1, numbers.maxIndex ?? -1) + 1;
            const entry = JSON.parse(JSON.stringify(moved));
            const nid = this.lib.nextId++;
            const k = String(numbers.freeKey);
            /** @type {object[]} */
            const records = [];
            const stamp = await this.stamper(actor, records);
            records.push(
                ...valueRecords(nid, null, entryValues(entry, k, false), historyWrites(stamp)),
                { kind: 'entityCreate', entity: nid, type: TYPE.entry, key: `${to.id}:${k}`, added: 0 },
                { kind: 'itemPlace', entity: to.id, list: 0, item: nid, position: (numbers.lastPosition ?? 0) + POSITION_GAP },
                ...(entry.displayIndex === null ? [] : [{ kind: 'entryIndex', entry: nid, book: to.id, index: entry.displayIndex }]),
            );
            if (deleteOriginal) records.push({ kind: 'histEntityDelete', entity: e.id, ...stamp() });
            await this.store.commit(records);
            return { entry };
        });
    }

    /**
     * @param {string} name
     * @param {string | number} uid
     * @returns {Promise<{ book: bigint, id: bigint } | 'missing' | 'no entry'>}
     */
    async entryOf(name, uid) {
        const found = await this.find(name);
        if (!found?.defined) return 'missing';
        const [id] = await this.lib.ids(TYPE.entry, [`${found.id}:${String(uid)}`]);
        return id === null ? 'no entry' : { book: found.id, id };
    }

    /**
     * @param {{ world: string, uid: string | number }[]} entries
     * @returns {Promise<({ book: bigint, entry: bigint } | null)[]>}
     */
    async entryRefs(entries) {
        /** @type {Map<string, bigint | null>} */
        const books = new Map();
        for (const { world } of entries) {
            if (books.has(world)) continue;
            const found = await this.find(world);
            books.set(world, found?.defined ? found.id : null);
        }
        const keys = entries.map(({ world, uid }) => {
            const book = books.get(world);
            return book === null || book === undefined ? null : `${book}:${String(uid)}`;
        });
        const asked = keys.filter(k => k !== null);
        const ids = asked.length ? await this.lib.ids(TYPE.entry, asked) : [];
        let next = 0;
        return keys.map((key, i) => {
            if (key === null) return null;
            const id = ids[next++];
            return id === null ? null : { book: /** @type {bigint} */ (books.get(entries[i].world)), entry: id };
        });
    }

    /**
     * @param {bigint[]} ids
     * @returns {Promise<({ book: string, bookName: string, uid: string, comment: unknown, key: unknown } | null)[]>}
     */
    async describeEntries(ids) {
        const entities = await this.lib.entities(ids);
        const bookOf = (/** @type {import('./entity-values.js').StoredEntity} */ e) => BigInt(e.key.slice(0, e.key.indexOf(':')));
        const bookIds = [...new Set(entities.flatMap(e => (e ? [bookOf(e)] : [])))];
        const books = new Map((await this.lib.entities(bookIds)).map((b, i) => [bookIds[i], b]));
        return entities.map(e => {
            const book = e ? books.get(bookOf(e)) : null;
            if (!e || !book) return null;
            const name = book.values.find(v => v.field === 'name')?.text;
            const entry = /** @type {Record<string, unknown>} */ (entryObject(e, false));
            return {
                book: book.key,
                bookName: typeof name === 'string' && name ? name : book.key,
                uid: e.key.slice(e.key.indexOf(':') + 1),
                comment: entry.comment,
                key: entry.key,
                content: entry.content,
            };
        });
    }

    /**
     * @param {bigint} entity
     * @param {number | string | null} field
     * @param {{ before?: bigint, limit?: number }} [page]
     */
    history(entity, field, { before, limit = 50 } = {}) {
        return this.store.worldRead('history', { entity, field, ...(before === undefined ? {} : { before }), limit });
    }

    /**
     * @param {bigint} entity
     * @param {number | string} field
     * @param {bigint} change
     * @returns {Promise<{ json: boolean, value: string } | null>}
     */
    historyValue(entity, field, change) {
        return this.store.worldRead('historyValue', { entity, field, id: change });
    }

    /**
     * @param {bigint} entity
     * @param {{ after?: number | string | null, limit?: number }} [page]
     */
    historyFields(entity, { after, limit = 100 } = {}) {
        return this.store.worldRead('historyFields', { entity, ...(after === undefined ? {} : { after }), limit });
    }

    /**
     * @param {string} name
     * @param {{ after?: bigint, limit?: number }} [page]
     * @returns {Promise<'missing' | { entries: { id: bigint, uid: string, position: number | null, index: number | null }[], more: boolean }>}
     */
    async deleted(name, { after, limit = 100 } = {}) {
        const found = await this.find(name);
        if (!found?.defined) return 'missing';
        const page = await this.store.worldRead('deleted', { book: found.id, ...(after === undefined ? {} : { after }), limit });
        return {
            entries: page.entries.map((/** @type {any} */ d) => ({ id: d.id, uid: d.key, position: d.position, index: d.index })),
            more: page.more,
        };
    }

    /**
     * @param {string} name
     * @param {string | number} uid
     * @param {number | string} field
     * @param {bigint} change
     * @param {Actor | null} [actor]
     * @returns {Promise<{ entry: object } | 'missing' | 'no entry'>}
     */
    revert(name, uid, field, change, actor = null) {
        return this.lane([bookKey(name)], async () => {
            const at = await this.entryOf(name, uid);
            if (typeof at === 'string') return at;
            /** @type {object[]} */
            const records = [];
            const stamp = await this.stamper(actor, records);
            records.push({ kind: 'histRevert', entity: at.id, field, target: change, ...stamp() });
            if (field === DISPLAY_INDEX) {
                const [now] = await this.lib.entities([at.id]);
                const was = await this.historyValue(at.id, field, change);
                const v = was === null ? undefined : was.json ? JSON.parse(was.value) : was.value;
                const index = v != null ? Number(v) : undefined;
                if (!Object.is(index, now?.entryIndex)) records.push({ kind: 'entryIndex', entry: at.id, book: at.book, ...(index === undefined ? {} : { index }) });
            }
            await this.store.commit(records);
            const [e] = await this.lib.entities([at.id]);
            return { entry: entryObject(/** @type {import('./entity-values.js').StoredEntity} */ (e), false) };
        });
    }

    /**
     * @param {string} name
     * @param {bigint} id
     * @param {Actor | null} [actor]
     * @returns {Promise<{ uid: string, entry: object } | 'missing' | 'no entry' | 'full'>}
     */
    restore(name, id, actor = null) {
        return this.lane([bookKey(name)], async () => {
            const found = await this.find(name);
            if (!found?.defined) return 'missing';
            const page = await this.store.worldRead('deleted', { book: found.id, after: id - 1n, limit: 1 });
            const d = page.entries[0];
            if (!d || d.id !== id) return 'no entry';
            let uid = /** @type {string} */ (d.key);
            const numbers = await this.store.worldRead('numbers', { book: found.id });
            const [taken] = await this.lib.ids(TYPE.entry, [`${found.id}:${uid}`]);
            if (taken !== null) {
                if (numbers.freeKey >= MAX_UID) return 'full';
                uid = String(numbers.freeKey);
            }
            /** @type {number | null} */
            let position = d.position;
            if (position !== null) {
                const there = await this.store.worldRead('entries', { book: found.id, ...(position > 0 ? { after: position - 1 } : {}), limit: 1 });
                if (there.entries[0]?.position === position) position = null;
            }
            /** @type {object[]} */
            const records = [];
            const stamp = await this.stamper(actor, records);
            records.push(
                { kind: 'histRestore', entity: id, type: TYPE.entry, key: `${found.id}:${uid}`, added: 0, ...stamp() },
                { kind: 'itemPlace', entity: found.id, list: 0, item: id, position: position ?? (numbers.lastPosition ?? 0) + POSITION_GAP },
                ...(d.index === null ? [] : [{ kind: 'entryIndex', entry: id, book: found.id, index: d.index }]),
            );
            await this.store.commit(records);
            const [e] = await this.lib.entities([id]);
            return { uid, entry: entryObject(/** @type {import('./entity-values.js').StoredEntity} */ (e), false) };
        });
    }

    /**
     * @param {string} name
     * @param {bigint} id
     * @param {{ field?: number | string | null, change?: bigint, marker?: boolean }} what
     * @param {Actor | null} [actor]
     * @returns {Promise<'ok' | 'missing' | 'no entry'>}
     */
    forget(name, id, { field = null, change, marker = true }, actor = null) {
        return this.lane([bookKey(name)], async () => {
            const found = await this.find(name);
            if (!found?.defined) return 'missing';
            const [e] = await this.lib.entities([id]);
            const live = e !== null && e.type === TYPE.entry && e.key.startsWith(`${found.id}:`);
            if (!live) {
                const page = await this.store.worldRead('deleted', { book: found.id, after: id - 1n, limit: 1 });
                if (page.entries[0]?.id !== id) return 'no entry';
            }
            /** @type {object[]} */
            const records = [];
            const { id: own, ...who } = (await this.stamper(actor, records))();
            records.push({
                kind: 'histForget',
                entity: id,
                ...(change === undefined ? {} : { target: change, ...(field === null ? {} : { field }) }),
                marker,
                ...(marker ? { id: own } : {}),
                ...who,
            });
            await this.store.commit(records);
            return 'ok';
        });
    }

    /**
     * @param {bigint} owner
     * @param {string} slot
     */
    async owned(owner, slot) {
        const [id] = await this.lib.ids(TYPE.ownedBook, [`${owner}:${slot}`]);
        if (id === null) return undefined;
        return this.assemble(await this.stored(id, false), false);
    }

    /**
     * @param {bigint} owner
     * @param {string} slot
     * @param {Record<string, unknown> | undefined} book
     * @param {Actor | null} [actor]
     */
    async ownedRecords(owner, slot, book, actor = null) {
        const [id] = await this.lib.ids(TYPE.ownedBook, [`${owner}:${slot}`]);
        const s = id === null ? null : await this.stored(id, false);
        /** @type {object[]} */
        const records = [];
        const stamp = await this.stamper(actor, records);
        if (book === undefined) return s ? [...records, ...this.deleteRecords(s, stamp)] : [];
        return [...records, ...(await this.bookRecords(id ?? this.lib.nextId++, s, book, { ownedKey: `${owner}:${slot}` }, stamp))];
    }
}

/**
 * @param {StoredBook} s
 * @param {boolean} world
 * @returns {Record<string, unknown>}
 */
function assembleBook(s, world) {
    /** @type {Map<string, unknown>} */
    const found = new Map();
    let order;
    for (const v of s.entity?.values ?? []) {
        if (v.field === DEFINED) continue;
        if (v.field === ORDER) {
            order = v.text;
            continue;
        }
        if (typeof v.field === 'string') found.set(v.field, v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json)));
    }
    if (s.original) found.set('originalData', assembleBook(s.original, false));
    const list = [...s.entries.values()].sort((a, b) => a.position - b.position);
    if (world) {
        /** @type {Record<string, unknown>} */
        const entries = {};
        for (const x of list) setOwn(entries, x.entity.key.slice(x.entity.key.indexOf(':') + 1), entryObject(x.entity, false));
        found.set('entries', entries);
    } else {
        found.set('entries', list.map(x => entryObject(x.entity, true)));
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of ordered(bookCanonical([...found.keys()]), order)) setOwn(out, k, found.get(k));
    return out;
}

/**
 * @param {any} read
 * @returns {StoredBook}
 */
function storedOfRead(read) {
    return {
        id: read.id,
        entity: read.entity,
        entries: new Map(read.entries.map((/** @type {any} */ x) => [x.entity.key.slice(x.entity.key.indexOf(':') + 1), x])),
        original: read.original ? storedOfRead(read.original) : null,
    };
}

/**
 * @param {any} store
 * @param {string} name
 * @returns {boolean}
 */
export function bookExistsHere(store, name) {
    const key = bookKey(name);
    return key ? store.worldBookExistsSync(key) : false;
}

/**
 * @param {any} store
 * @param {string} name
 * @returns {Record<string, unknown> | null}
 */
export function readBookHere(store, name) {
    const key = bookKey(name);
    if (!key) return null;
    const read = store.worldBookSync(key);
    return read ? assembleBook(storedOfRead(read), true) : null;
}

/**
 * @param {string[]} keys
 * @param {Map<string, number>} stored
 * @returns {Map<string, number>}
 */
export function placeEntries(keys, stored) {
    /** @type {Map<string, number>} */
    const out = new Map();
    let prev = -1;
    let ok = true;
    for (const k of keys) {
        const p = stored.get(k);
        if (p === undefined) continue;
        if (p <= prev) ok = false;
        prev = p;
    }
    if (ok) {
        let lo = -1;
        for (let i = 0; i < keys.length && ok; i++) {
            const p = stored.get(keys[i]);
            if (p !== undefined) {
                lo = p;
                continue;
            }
            let j = i;
            while (j < keys.length && !stored.has(keys[j])) j++;
            const hi = j < keys.length ? /** @type {number} */ (stored.get(keys[j])) : lo + POSITION_GAP * (j - i + 1);
            const step = Math.floor((hi - lo) / (j - i + 1));
            if (step < 1) {
                ok = false;
                break;
            }
            for (let m = i; m < j; m++) out.set(keys[m], lo + step * (m - i + 1));
            lo = lo + step * (j - i);
            i = j - 1;
        }
    }
    if (ok) return out;
    out.clear();
    const top = [...stored.values()].reduce((m, p) => Math.max(m, p), 0);
    keys.forEach((k, i) => out.set(k, top + POSITION_GAP * (i + 1)));
    return out;
}
