import { jsonHash } from '../public/scripts/hash-utils.js';
import { POSITION_GAP, historyWrites, itemField, pushAll, valueRecords } from './entity-values.js';
import { SPACE, actorIds } from './actor-ids.js';
import { LINKS, storedLinks } from './character-links.js';
import { TYPE } from './library-codes.js';
import { bookKey } from './world-info-keys.js';
import { cursorWeights, cursorWeightsOf, searchClauses } from './search-clauses.js';

/**
 * World info on the engine: books and their entries as entities whose values are the engine's records.
 *
 * A world book is found by its key (`bookKey()`); a book a character or a world book owns (a card's
 * `character_book`, a book's `originalData`) by its owner (`<owner id>:c`, `<owner id>:o`). Each top-level key of a
 * book (but `entries`) and of an entry is its own value: a string as text, anything else as JSON; an entry's keys
 * lists (`key`, `keysecondary`, `triggers`, `keys`, `secondary_keys`) as items when they are non-empty lists of
 * strings. Upstream's entry keys have field codes; any other key is stored by its name. An entry's `extensions`,
 * when an object, is stored a key at a time too (`EXTENSION_KEYS`), so the keys upstream reads from it (a character
 * book entry's `group`, `automation_id`, ...) are values of their own, edited and searched. A write records only
 * what differs from what is stored. Assembled, a book or entry has its keys in the order they came.
 *
 * An entry keeps its history (`store::history`): each committed change of it is recorded with who made it (the user,
 * the tab's session) and when, so it can be read back, reverted, or forgotten, and a deleted entry restored.
 */

/** Field codes of an entry's keys: upstream's World Info entry, then a character book's (`character_book`). */
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
/** The `extensions` keys upstream's `convertCharacterBook()` reads, in its order: field codes from 160. */
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
/** Another `extensions` key is stored by its name after this mark; an entry's own key starting with either mark
 * after `KEY_ESCAPE`. */
const EXTENSION_MARK = '\u0001';
const KEY_ESCAPE = '\u0002';
/** The order of `extensions`' keys, when it isn't the canonical one. */
const EXTENSION_ORDER = 99;
/** A whole entry that isn't an object, as JSON. */
const WHOLE = 96;
/** A world book's entry with no `uid` key (its default is its key as a number). */
const NO_UID = 97;
/** The order of an object's keys, when it isn't the canonical one (`orderValue()`). */
const ORDER = 98;
/** A world book's definition marker (`books::DEFINED`). */
const DEFINED = 41;
const UID = ENTRY_CODE_BASE;

const ENTRY_CODE = new Map(ENTRY_KEYS.map((k, i) => [k, ENTRY_CODE_BASE + i]));
/** An entry's `extensions` (its value a marker, empty JSON, when it is an object stored a key at a time). */
const EXTENSIONS = /** @type {number} */ (ENTRY_CODE.get('extensions'));
const ENTRY_NAME = new Map(ENTRY_KEYS.map((k, i) => [ENTRY_CODE_BASE + i, k]));
const ENTRY_LIST = new Map([['key', 0], ['keysecondary', 1], ['triggers', 2], ['keys', 3], ['secondary_keys', 4]]);
const ENTRY_LIST_NAME = new Map([...ENTRY_LIST].map(([k, v]) => [v, k]));

/** Upstream's limit on a new entry's uid (`getFreeWorldEntryUid()`). */
const MAX_UID = 1_000_000;
/** An entry's `displayIndex`, which its `entryIndex` record follows. */
const DISPLAY_INDEX = /** @type {number} */ (ENTRY_CODE.get('displayIndex'));

/**
 * @typedef {object} Actor Who writes.
 * @property {string} user The user's handle.
 * @property {string | null} [session] The tab's session (`X-ST-Session`); `none`, a deleted session's or none: no
 * session.
 */

/** Book slots of an owned book's key. */
export const SLOT = Object.freeze({ characterBook: 'c', originalData: 'o' });

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a value is a book the store keeps as its own entries: an object whose `entries` is a list of objects.
 * Anything else a card's `character_book` or a book's `originalData` holds is kept as it came, as JSON.
 * @param {unknown} v
 * @returns {v is { entries: object[] }}
 */
export function isEntryList(v) {
    return isPlainObject(v) && Array.isArray(/** @type {any} */ (v).entries) && /** @type {any} */ (v).entries.every(isPlainObject);
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
 * The value recording `keys`' order when it isn't `canonical`'s: each key's place in the canonical order, one
 * character each.
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
 * `keys` in the order `orderValue()` recorded (none: as they are).
 * @param {string[]} canonical
 * @param {string | undefined} order
 */
function ordered(canonical, order) {
    if (order === undefined || order.length !== canonical.length) return canonical;
    return [...order].map(c => canonical[c.charCodeAt(0) - 0x20]);
}

/** An entry's keys in canonical order: upstream's by code, then any other by name. */
function entryCanonical(/** @type {string[]} */ keys) {
    const known = keys.filter(k => ENTRY_CODE.has(k)).sort((a, b) => /** @type {number} */ (ENTRY_CODE.get(a)) - /** @type {number} */ (ENTRY_CODE.get(b)));
    const other = keys.filter(k => !ENTRY_CODE.has(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [...known, ...other];
}

/** `extensions`' keys in canonical order: upstream's by code, then any other by name. */
function extensionCanonical(/** @type {string[]} */ keys) {
    const known = keys.filter(k => EXTENSION_CODE.has(k)).sort((a, b) => /** @type {number} */ (EXTENSION_CODE.get(a)) - /** @type {number} */ (EXTENSION_CODE.get(b)));
    const other = keys.filter(k => !EXTENSION_CODE.has(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [...known, ...other];
}

/** The field an entry's own key without a code is stored by: its name, escaped when it starts with a mark. */
const ownKeyField = (/** @type {string} */ k) => (k.startsWith(EXTENSION_MARK) || k.startsWith(KEY_ESCAPE) ? KEY_ESCAPE + k : k);

/** A book's keys in canonical order: by name, `entries` last. */
function bookCanonical(/** @type {string[]} */ keys) {
    return [...keys.filter(k => k !== 'entries').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), ...(keys.includes('entries') ? ['entries'] : [])];
}

const put = (/** @type {unknown} */ v) => (typeof v === 'string' ? { text: v } : { json: JSON.stringify(v) });

/**
 * An entry's values and lists. A world book's entry whose `uid` is its key as a number stores no `uid`.
 * @param {unknown} entry
 * @param {string} key Its key in its book.
 * @param {boolean} owned Whether its book is owned (no default `uid`).
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
 * The entry an entity's values hold, the inverse of entryValues().
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
 * A book's own values (every key but `entries`, and but `originalData` when it is kept as an owned book).
 * @param {Record<string, unknown>} book
 * @param {boolean} defined A world book (with its definition marker).
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
    // The marker last, so the book is listed once its values are there.
    if (defined) values.set(DEFINED, { json: '' });
    return { values, lists: new Map() };
}

/**
 * @typedef {object} StoredBook A book as stored, for writing over it.
 * @property {bigint} id
 * @property {import('./entity-values.js').StoredEntity | null} entity
 * @property {Map<string, { entity: import('./entity-values.js').StoredEntity, position: number }>} entries By key.
 * @property {StoredBook | null} original A world book's owned `originalData`.
 */

/**
 * World info of one user's store, beside its library (`LibraryEngine`).
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
     * Runs `write` in the lane of the book keyed `key` (and of the keys in `more`, all in one order).
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
     * The world book a name finds: its id and whether it is defined (else an unresolved name a link holds).
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
     * Stamps for the changes of one write by `actor` (null: by no one known): each its own change id, the write's
     * time, and the actor's user and session (their keys made in `records` when new).
     * @param {Actor | null | undefined} actor
     * @param {object[]} records
     * @returns {Promise<() => import('./entity-values.js').Stamp>}
     */
    async stamper(actor, records) {
        const next = await this.lib.nextIds();
        /** @type {{ user: bigint | null, session: bigint | null }} */
        let ids = { user: null, session: null };
        if (actor) {
            let session = actor.session && actor.session !== 'none' ? actor.session : null;
            if (session !== null) {
                const [state] = await this.store.chatRead('keyStates', { space: SPACE.session, keys: [session] });
                if (state === 'gone') session = null;
            }
            ids = await actorIds(this.store, next, { user: actor.user, session }, records);
        }
        const time = Date.now();
        return () => ({
            id: next.change++,
            time,
            ...(ids.user === null ? {} : { user: ids.user }),
            ...(ids.session === null ? {} : { session: ids.session }),
        });
    }

    /**
     * Whether a world book has this name.
     * @param {string} name
     */
    async exists(name) {
        return (await this.find(name))?.defined ?? false;
    }

    /**
     * A book's entries in their places, with their entities.
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
     * A book as stored, for writing over it.
     * @param {bigint} id
     * @param {boolean} world A world book (which may own its `originalData`).
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
     * A stored book in upstream's shape (`assembleBook()`).
     * @param {StoredBook} s
     * @param {boolean} world
     * @returns {Record<string, unknown>}
     */
    assemble(s, world) {
        return assembleBook(s, world);
    }

    /**
     * A world book in upstream's shape (`readWorldInfoFile()`), or null when no book has the name.
     * @param {string} name
     */
    async read(name) {
        const found = await this.find(name);
        if (!found?.defined) return null;
        return this.assemble(await this.stored(found.id, true), true);
    }

    /**
     * The defined world books as `/api/worldinfo/list` answers them, in its order.
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
     * The records turning a stored book (`s`, none for a new one) into `book`.
     * @param {bigint} id
     * @param {StoredBook | null} s
     * @param {Record<string, unknown>} book
     * @param {{ world?: boolean, ownedKey?: string }} where A world book, or an owned book's key.
     * @param {() => import('./entity-values.js').Stamp} stamp The entries' changes' (`stamper()`).
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
     * The records making a world book's entries `incoming` (key, entry), in that order.
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
     * The records making an owned book's entries the list `incoming`: entries equal at both ends stay, those
     * between are edited in place, the rest added or deleted.
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
     * The records deleting a book's entries and, for an owned book, the book (a world book's entity stays, its
     * marker gone, as an unresolved name its links keep).
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
     * Writes a world book whole (`/edit`, an import, a create with data): only what differs from the stored book.
     * A book named as an unresolved name takes that entity, so the links holding the name resolve to it.
     * @param {string} name
     * @param {Record<string, unknown>} data
     * @param {Actor | null} [actor]
     * @returns {Promise<{ records: number }>}
     */
    write(name, data, actor = null) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const [found] = await this.lib.ids(TYPE.book, [key]);
            const id = found ?? this.lib.nextId++;
            const s = found === null ? null : await this.stored(found, true);
            /** @type {object[]} */
            const keyed = [];
            const records = await this.bookRecords(id, s, data, { world: true }, await this.stamper(actor, keyed));
            // Listed once its marker is written, after its values.
            if (found === null) records.unshift({ kind: 'entityCreate', entity: id, type: TYPE.book, key, added: Date.now() });
            if (records.length > 0) await this.store.commit([...keyed, ...records]);
            return { records: records.length };
        });
    }

    /**
     * Deletes a world book: its entries and values go; its links keep its name, unresolved.
     * @param {string} name
     * @param {Actor | null} [actor]
     * @returns {Promise<boolean>} Whether there was such a book.
     */
    delete(name, actor = null) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const found = await this.find(name);
            if (!found?.defined) return false;
            /** @type {object[]} */
            const records = [];
            const stamp = await this.stamper(actor, records);
            pushAll(records, this.deleteRecords(await this.stored(found.id, true), stamp));
            // The links keep the book's name; a card whose hash was made from another reading is made current.
            pushAll(records, await this.lib.identityRecords(await this.linkers(found.id), key, [key]));
            await this.store.commit(records);
            return true;
        });
    }

    /**
     * Renames a world book: its key changes, and every link follows it. A new name that is an unresolved name
     * resolves to this book from now on. With `relink` false (upstream's `relink_characters: false`), the
     * characters with a link resolving as the book keep the name they read as now: each such link becomes a link to
     * one unresolved book holding the old name (a character's later links resolving as the book go, the first
     * kept).
     * @param {string} name
     * @param {string} newName
     * @param {{ relink?: boolean, moved?: bigint[] }} [options] `moved` gets the characters whose link the rename
     * moved to the new name (with `relink`, those linking the book).
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
                        // The first such link holds the new book in place (no link names it yet); the rest go.
                        links.forEach((l, n) => records.push(n === 0
                            ? { kind: 'textValue', entity: e.id, field: itemField(LINKS, l.item), text: String(kept) }
                            : { kind: 'itemDelete', entity: e.id, list: LINKS, item: l.item }));
                    }
                }
            }
            // The cards whose first link reads as the book or the new name now read as the new name: their identity
            // hashes follow, in the same commit.
            const linkers = [...(relink ? own : []), ...(there ? await this.linkers(there.id) : [])];
            pushAll(records, await this.lib.identityRecords(linkers, to, relink ? [from, to] : [to]));
            await this.store.commit(records);
            if (moved && relink) pushAll(moved, own);
            return 'ok';
        });
    }

    /**
     * Every character whose lorebook link resolves as `book`: linking it, or an unresolved name forwarded into it.
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
     * Applies changes a page made to its copy of a book (`/entries/apply`), each against the version it had.
     * @param {string} name
     * @param {{ uid: string | number, base_hash?: number | null, data?: object | null }[]} entryChanges
     * @param {{ key: string, base_hash?: number | null, value?: unknown }[]} fieldChanges
     * @param {Actor | null} [actor]
     * @returns {Promise<null | { ok: true, entries: Record<string, object>, deleted: string[], fields: Record<string, unknown>, conflicts: object[] }>}
     */
    apply(name, entryChanges, fieldChanges, actor = null) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const found = await this.find(name);
            if (!found?.defined) return null;
            const book = found.id;
            const [bookEntity] = await this.lib.entities([book]);
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
            /** Keys whose stored entry a change deleted. */
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
            // The book's own fields, `originalData` among them, read only when a field may change.
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
            // A deleted entry leaves the book's `originalData` too (non-strict: uids arrive as numbers or strings).
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
     * A new entry `{ uid }` at the end of a book, under its lowest free integer key (`/entry/create`).
     * @param {string} name
     * @returns {Promise<{ entry: { uid: number } } | 'missing' | 'full'>}
     */
    createEntry(name) {
        const key = bookKey(name);
        return this.lane([key], async () => {
            const found = await this.find(name);
            if (!found?.defined) return 'missing';
            const numbers = await this.store.worldRead('numbers', { book: found.id });
            if (numbers.freeKey >= MAX_UID) return 'full';
            const id = this.lib.nextId++;
            await this.store.commit([
                { kind: 'entityCreate', entity: id, type: TYPE.entry, key: `${found.id}:${numbers.freeKey}`, added: 0 },
                { kind: 'itemPlace', entity: found.id, list: 0, item: id, position: (numbers.lastPosition ?? 0) + POSITION_GAP },
            ]);
            return { entry: { uid: numbers.freeKey } };
        });
    }

    /**
     * Writes one entry whole (`/entry/edit`); its `uid` stays the stored one.
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
     * Moves or copies an entry into another book (`/entry/transplant`): under the target's lowest free integer
     * key, after its highest `displayIndex`, at its end; both books in one commit.
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
            // As JSON stores it: a NaN index is null.
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
     * The entry of world book `name` keyed `uid`: its book and entity, or why there is none.
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
     * Up to `limit` of an entry's changes of `field` (a field code or key, as its values are stored; null: the
     * entry's own, its deletes and restores) before change `before`, last first: `{ changes: [{ id, kind, time,
     * session, user, json?, position?, by? }], more }` (`store::history::history_page`). A deleted entry's is read by
     * its id too.
     * @param {bigint} entity
     * @param {number | string | null} field
     * @param {{ before?: bigint, limit?: number }} [page]
     */
    history(entity, field, { before, limit = 50 } = {}) {
        return this.store.worldRead('history', { entity, field, ...(before === undefined ? {} : { before }), limit });
    }

    /**
     * An entry's field as change `change` left it: `{ json, value }`, or null when it had no value.
     * @param {bigint} entity
     * @param {number | string} field
     * @param {bigint} change
     * @returns {Promise<{ json: boolean, value: string } | null>}
     */
    historyValue(entity, field, change) {
        return this.store.worldRead('historyValue', { entity, field, id: change });
    }

    /**
     * Up to `limit` of the fields an entry has history of, after `after` (null: after the entry's own): `{ fields:
     * (number | string | null)[], more }`, the entry's own as null, first.
     * @param {bigint} entity
     * @param {{ after?: number | string | null, limit?: number }} [page]
     */
    historyFields(entity, { after, limit = 100 } = {}) {
        return this.store.worldRead('historyFields', { entity, ...(after === undefined ? {} : { after }), limit });
    }

    /**
     * Up to `limit` of world book `name`'s deleted entries after the entity `after`, in id order: `{ entries: [{ id,
     * uid, position, index }], more }` (its uid, place and `displayIndex` when it was deleted).
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
     * Sets an entry's field back to what change `change` left it as, as a new change: its value, or (a list item's
     * field, and a place change) the item's place. Its `entryIndex` follows a `displayIndex` set back.
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
     * Restores a deleted entry of world book `name` (`id`: its entity, as `deleted()` lists it) with the values it
     * had: under its old uid when that is free, else the book's lowest free one; at its old place when that is free,
     * else at the book's end.
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
     * Forgets past changes of an entry of world book `name` (`id`: its entity, a deleted one's too): change `change`
     * of `field` (null: one of the entry's own), or, with no change, its whole history up to now. With `marker` (the
     * default) a change saying who forgot them and when takes their place; without, nothing of them is left. The
     * current value of every field stays; the change that set one can't be forgotten.
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
     * An owned book in upstream's shape, or undefined when the owner has none.
     * @param {bigint} owner
     * @param {string} slot
     */
    async owned(owner, slot) {
        const [id] = await this.lib.ids(TYPE.ownedBook, [`${owner}:${slot}`]);
        if (id === null) return undefined;
        return this.assemble(await this.stored(id, false), false);
    }

    /**
     * A page of a book's entries a search string matches, best first, over upstream's `fuzzySearchWorldInfo` fields
     * (`key` 20, `group` 15, `comment` 10, `keysecondary` 10, `content` 3, `uid` and `automationId` 1; the last word
     * a prefix in `key` and `comment`). The book is a world book (`name`) or a character's own book (`character`, its
     * entity id). Each entry is answered by its key in the book (a world book's: its uid); `cursor` reads on from
     * the page before's.
     * @param {object} p
     * @param {string} [p.name]
     * @param {bigint} [p.character]
     * @param {string} p.search
     * @param {number} p.limit
     * @param {string} [p.cursor]
     * @returns {Promise<'missing' | { entries: { uid: string, score: number }[], total: number, totalExact: boolean, cursor?: string }>}
     */
    async search({ name, character, search, limit, cursor }) {
        let book = null;
        if (character !== undefined) {
            [book] = await this.lib.ids(TYPE.ownedBook, [`${character}:${SLOT.characterBook}`]);
        } else if (name !== undefined) {
            const found = await this.find(name);
            book = found?.defined ? found.id : null;
        }
        if (book === null) return 'missing';
        const clauses = searchClauses(search);
        if (clauses.length === 0) return { entries: [], total: 0, totalExact: true };
        // `s<rank>:<doc>`, then `:<idf>,…` with several words (`cursorWeightsOf`). A cursor that doesn't read, or
        // whose weights don't fit the query's words, is none.
        const m = typeof cursor === 'string' ? /^s([^:]+):(\d+)(?::([^:]*))?$/.exec(cursor) : null;
        const weights = m?.[3] === undefined ? undefined : cursorWeights(m[3]);
        const after = m && Number.isFinite(Number(m[1])) && weights !== null
            ? { score: Number(m[1]), doc: BigInt(m[2]), ...(weights ? { weights } : {}) }
            : undefined;
        const read = (/** @type {object | undefined} */ from) => this.store.search({ scope: { book }, clauses, limit, ...(from ? { after: from } : {}) });
        let found;
        try {
            found = await read(after);
        } catch (err) {
            if (!after || !/^invalid cursor/.test(String(/** @type {any} */ (err)?.message))) throw err;
            found = await read(undefined);
        }
        const entities = await this.lib.entities(found.hits.map((/** @type {any} */ h) => h.doc));
        const entries = found.hits.flatMap((/** @type {any} */ h, /** @type {number} */ i) => {
            const e = entities[i];
            return e ? [{ uid: e.key.slice(e.key.indexOf(':') + 1), score: h.score }] : [];
        });
        return {
            entries,
            total: found.total,
            totalExact: found.totalExact,
            ...(found.next ? { cursor: `s${found.next.score}:${found.next.doc}${cursorWeightsOf(found.next)}` } : {}),
        };
    }

    /**
     * The records making an owner's book `book` (undefined: none).
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
 * A stored book in upstream's shape: a world book's `entries` an object by key, an owned book's a list.
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
 * A book as `Store.worldBookSync` read it, as stored (`WorldInfoEngine.stored()`).
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
 * Whether a world book has this name (`WorldInfoEngine.exists()`), read on this thread from one state of the store.
 * @param {any} store The binding's `Store` (`engineStoreHere()`)
 * @param {string} name
 * @returns {boolean}
 */
export function bookExistsHere(store, name) {
    const key = bookKey(name);
    return key ? store.worldBookExistsSync(key) : false;
}

/**
 * A world book in upstream's shape (`WorldInfoEngine.read()`), read on this thread from one state of the store, or
 * null when no book has the name.
 * @param {any} store The binding's `Store` (`engineStoreHere()`)
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
 * Places for entries in the order of `keys`, given the stored ones: new entries between their neighbours; when the
 * stored ones are out of that order or no place is free, every entry again, above every place held.
 * @param {string[]} keys
 * @param {Map<string, number>} stored
 * @returns {Map<string, number>} The places that change.
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
