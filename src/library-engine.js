import _ from 'lodash';

import { CARD_COLUMNS, assembleCard, splitCard } from './character-card-storage.js';
import { computeContentIdentityHash } from './card-identity-hash.js';
import { LIST_CREATOR_NOTES_PATHS, LIST_EXTRA_PATHS, cardListValues } from './card-list-values.js';
import { calculateDataSize } from './character-shallow.js';
import { parseCreateDateToEpochMs } from './util.js';
import { tagDerivedColumns } from './tag-order.js';
import { LibraryTags } from './library-engine-tags.js';
import { textEdit, wtf8Length } from './text-edit.js';
import { itemField, pushAll, storedValues, valueRecords, withoutStatements } from './entity-values.js';
import { SPACE, actorIds } from './actor-ids.js';
import { LINKS, linkListRecords, storedLinks } from './character-links.js';
import { FIELD, NAME_HISTORY, STATEMENT_PREFIX, TAG_KEY_PREFIX, TYPE, renameItem, renamesOf } from './library-codes.js';
import { bookKey } from './world-info-keys.js';
import { LIBRARY_LABELS, cursorWeights, cursorWeightsOf, searchClauses } from './search-clauses.js';
import { SLOT, WorldInfoEngine, isEntryList } from './world-info-engine.js';
import { groupDigestContentHash, groupDigestFavHash, groupDigestTagIdsHash, normalizeFav, normalizeTagIds, tagNameKey } from '../public/scripts/hash-utils.js';

export { FIELD, TAG_KEY_PREFIX, TYPE, textEdit, wtf8Length, itemField, valueRecords };

/** @typedef {import('./entity-values.js').StoredEntity} StoredEntity */

export const LIST = Object.freeze({ alternate_greetings: 0, group_only_greetings: 1, tags: 2, nameHistory: NAME_HISTORY, links: LINKS });

export const GROUP_FIELD = Object.freeze({
    name: 1,
    avatar_url: 50,
    allow_self_responses: 51,
    activation_strategy: 52,
    generation_mode: 53,
    auto_mode_delay: 54,
    generation_mode_join_prefix: 55,
    generation_mode_join_suffix: 56,
    hideMutedSprites: 57,
});

export const GROUP_LIST = Object.freeze({ members: 3, disabled_members: 4 });

const GROUP_KEY_PREFIX = 'group:';

const GROUP_READ_KEYS = new Set(['id', 'fav', 'tag_ids', 'date_added', 'create_date', 'date_last_chat', 'chat_size', 'chat_id', 'chats']);

/**
 * @param {string} avatar
 */
export function ownerKeyOf(avatar) {
    return String(avatar).replace('.png', '');
}

export const HASH = Object.freeze({ identity: 0, content: 1, avatarIdentity: 3 });

/**
 * @param {string} cursor
 * @param {string} order
 * @returns {({ score: number, doc: bigint } | { tied: number, cursor: Buffer } | { below: number }) & { weights?: number[] } | 'invalid' | null}
 */
function parseRelevanceCursor(cursor, order) {
    const at = (/** @type {object} */ after, /** @type {string | undefined} */ list) => {
        if (list === undefined) return after;
        const weights = cursorWeights(list);
        return weights ? { ...after, weights } : null;
    };
    const s = /^s([^:]+):(\d+)(?::([^:]*))?$/.exec(cursor);
    if (s) {
        const score = Number(s[1]);
        return Number.isFinite(score) ? at({ score, doc: BigInt(s[2]) }, s[3]) : null;
    }
    const t = /^t([^:]+):([^.]*)\.([^:]*)(?::([^:]*))?$/.exec(cursor);
    if (t) {
        const tied = Number(t[1]);
        if (t[2] !== order) return 'invalid';
        return Number.isFinite(tied) ? at({ tied, cursor: Buffer.from(t[3], 'base64url') }, t[4]) : null;
    }
    const b = /^b([^:]+)(?::([^:]*))?$/.exec(cursor);
    if (b) {
        const below = Number(b[1]);
        return Number.isFinite(below) ? at({ below }, b[2]) : null;
    }
    return null;
}

/**
 * @param {{ score?: number, doc?: bigint, tied?: number, cursor?: Buffer, below?: number, weights?: number[] }} next
 * @param {string} order
 * @returns {string}
 */
function relevanceCursorOf(next, order) {
    const weights = cursorWeightsOf(next);
    if (next.tied !== undefined) return `t${next.tied}:${order}.${/** @type {Buffer} */ (next.cursor).toString('base64url')}${weights}`;
    if (next.below !== undefined) return `b${next.below}${weights}`;
    return `s${next.score}:${next.doc}${weights}`;
}

/**
 * @param {string | undefined} field
 * @param {string | undefined} order
 * @param {number | undefined} seed
 * @returns {Record<string, unknown>}
 */
function listSort(field, order, seed) {
    const desc = order === 'desc';
    if (field === 'random') return { seed: Number(seed) || 0, desc };
    if (field === 'fav') return { fav: true, desc };
    if (Object.hasOwn(SORT_KEYS, field ?? '')) return { key: SORT_KEYS[/** @type {keyof typeof SORT_KEYS} */ (field)], desc };
    return { key: SORT_KEYS.name, desc: false };
}

const PAIRS = Object.freeze({ indexing: 4, indexed: 5 });

export const SORT_KEYS = Object.freeze({ name: 0, create_date: 1, date_added: 2, date_last_chat: 3, chat_size: 4, data_size: 5 });

const EXTENSION_PREFIX = 'ext:';

/**
 * @param {boolean} includeCreatorNotes
 * @returns {{ fields: (number | string)[], lists: number[] }}
 */
export function listRowValues(includeCreatorNotes) {
    return {
        fields: [
            FIELD.name, FIELD.creator, FIELD.character_version, FIELD.world, FIELD.create_date, FIELD.allow_global_styles,
            ...(includeCreatorNotes ? [FIELD.creator_notes, ...LIST_CREATOR_NOTES_PATHS] : []),
            `${EXTENSION_PREFIX}world`, ...LIST_EXTRA_PATHS,
        ],
        lists: [LIST.tags],
    };
}

const NO_VALUES = Object.freeze({ fields: [], lists: [] });

/**
 * @param {import('./character-card-storage.js').CardParts} parts
 * @returns {{ values: Map<number | string, { text?: string, json?: string }>, lists: Map<number, string[]> }}
 */
export function cardValues(parts) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    const put = (/** @type {number | string} */ field, /** @type {unknown} */ value) => {
        values.set(field, typeof value === 'string' ? { text: value } : { json: JSON.stringify(value) });
    };
    for (const key of /** @type {const} */ (['name', 'creator', 'character_version', 'world', 'create_date'])) {
        if (parts.columns[key] !== undefined) put(FIELD[key], parts.columns[key]);
    }
    for (const [key, value] of Object.entries(parts.card)) put(FIELD[/** @type {keyof typeof FIELD} */ (key)], value);
    for (const { key, value } of parts.extensions) values.set(EXTENSION_PREFIX + key, { json: value });
    for (const { path, value } of parts.extra) values.set(path, { json: value ?? '' });
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    for (const list of /** @type {const} */ (['alternate_greetings', 'group_only_greetings'])) {
        const rows = parts.greetings.filter(g => g.list === list).sort((a, b) => a.position - b.position);
        if (rows.length > 0) lists.set(LIST[list], rows.map(g => g.text));
    }
    if (parts.tags.length > 0) lists.set(LIST.tags, [...parts.tags].sort((a, b) => a.position - b.position).map(t => t.name));
    return { values, lists };
}

/**
 * @param {string[]} items
 * @param {{ from: string, pastChats: boolean, at?: number }} renamed
 * @returns {string[]}
 */
function renamedHistory(items, { from, pastChats, at = Date.now() }) {
    if (pastChats) return [];
    const until = Math.max(at, renamesOf(items.slice(-1))[0]?.until ?? 0);
    return [...items, renameItem({ until, name: from })];
}

const CODE_NAMES = new Map(Object.entries(FIELD).map(([k, v]) => [v, k]));
const LIST_NAMES = new Map(Object.entries(LIST).map(([k, v]) => [v, k]));

/**
 * @param {StoredEntity} entity
 * @returns {import('./character-card-storage.js').CardParts}
 */
export function cardParts(entity) {
    /** @type {import('./character-card-storage.js').CardParts} */
    const parts = { columns: {}, card: {}, greetings: [], tags: [], extensions: [], extra: [] };
    const { values, lists } = storedValues(entity);
    for (const [field, v] of values) {
        if (typeof field === 'string') {
            if (field.startsWith(STATEMENT_PREFIX)) continue;
            if (field.startsWith(EXTENSION_PREFIX)) parts.extensions.push({ key: field.slice(EXTENSION_PREFIX.length), value: /** @type {string} */ (v.json) });
            else parts.extra.push({ path: field, value: v.json === '' ? null : /** @type {string} */ (v.json) });
            continue;
        }
        const name = CODE_NAMES.get(field);
        const value = v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json));
        if (name === 'name' || name === 'creator' || name === 'character_version' || name === 'world' || name === 'create_date') {
            /** @type {any} */ (parts.columns)[name] = value;
        } else if (name !== undefined && Object.hasOwn(CARD_COLUMNS, name)) {
            parts.card[name] = value;
        }
    }
    for (const [list, texts] of lists) {
        const name = LIST_NAMES.get(list);
        if (name === 'tags') texts.forEach((text, position) => parts.tags.push({ position, name: text }));
        else if (name === 'alternate_greetings' || name === 'group_only_greetings') texts.forEach((text, position) => parts.greetings.push({ list: name, position, text }));
    }
    if (parts.columns.world === undefined && entity.link) parts.columns.world = entity.link.key;
    parts.columns.fav = entity.fav;
    return parts;
}

const GROUP_CODE_NAMES = new Map(Object.entries(GROUP_FIELD).map(([k, v]) => [v, k]));
const GROUP_LIST_NAMES = new Map(Object.entries(GROUP_LIST).map(([k, v]) => [v, k]));

/**
 * @param {Record<string, unknown>} group
 * @returns {{ values: Map<number | string, { text?: string, json?: string }>, lists: Map<number, string[]> }}
 */
export function groupValues(group) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    for (const [key, value] of Object.entries(group)) {
        if (value === undefined || GROUP_READ_KEYS.has(key)) continue;
        const list = Object.hasOwn(GROUP_LIST, key) ? GROUP_LIST[/** @type {keyof typeof GROUP_LIST} */ (key)] : undefined;
        if (list !== undefined && Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string')) {
            lists.set(list, value);
            continue;
        }
        const field = Object.hasOwn(GROUP_FIELD, key) ? GROUP_FIELD[/** @type {keyof typeof GROUP_FIELD} */ (key)] : GROUP_KEY_PREFIX + key;
        values.set(field, typeof value === 'string' ? { text: value } : { json: JSON.stringify(value) });
    }
    return { values, lists };
}

/**
 * @param {bigint} id
 * @param {StoredEntity | null} stored
 * @param {Record<string, unknown>} group
 */
function groupRecords(id, stored, group) {
    const records = [];
    const fav = normalizeFav(group.fav);
    if (stored ? stored.fav !== fav : fav) records.push({ kind: 'fav', entity: id, fav });
    records.push(...valueRecords(id, withoutStatements(stored), groupValues(group)));
    return records;
}

/**
 * @param {StoredEntity} entity
 * @returns {Record<string, unknown>}
 */
export function groupObject(entity) {
    const { values, lists } = storedValues(entity);
    /** @type {Record<string, unknown>} */
    const group = { id: entity.key };
    const set = (/** @type {string} */ key, /** @type {unknown} */ value) => Object.defineProperty(group, key, { value, enumerable: true, writable: true, configurable: true });
    for (const [field, v] of values) {
        const key = typeof field === 'number' ? GROUP_CODE_NAMES.get(field) : field.startsWith(GROUP_KEY_PREFIX) ? field.slice(GROUP_KEY_PREFIX.length) : undefined;
        if (key !== undefined) set(key, v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json)));
    }
    for (const [list, texts] of lists) {
        const key = GROUP_LIST_NAMES.get(list);
        if (key !== undefined) set(key, texts);
    }
    return group;
}

export const FIND_WORK_CAP = 20000;

const IMPORT_LANE = -1;

const GROUP_RECORDS = 4000;

class GroupedCommits {
    /** @param {any} store */
    constructor(store) {
        this.store = store;
        /** @type {{ records: object[], resolve: () => void, reject: (err: unknown) => void }[]} */
        this.waiting = [];
        this.sending = false;
    }

    /**
     * @param {object[]} records
     * @returns {Promise<void>}
     */
    commit(records) {
        return new Promise((resolve, reject) => {
            this.waiting.push({ records, resolve, reject });
            this.next();
        });
    }

    next() {
        if (this.sending || this.waiting.length === 0) return;
        let n = 0;
        let size = 0;
        while (n < this.waiting.length && (n === 0 || size + this.waiting[n].records.length <= GROUP_RECORDS)) size += this.waiting[n++].records.length;
        const group = this.waiting.splice(0, n);
        this.sending = true;
        this.send(group).finally(() => {
            this.sending = false;
            this.next();
        });
    }

    /** @param {GroupedCommits['waiting']} group */
    async send(group) {
        try {
            await this.store.commit(group.flatMap(w => w.records));
            for (const w of group) w.resolve();
            return;
        } catch (err) {
            if (group.length === 1) return group[0].reject(err);
        }
        for (const w of group) {
            try {
                await this.store.commit(w.records);
                w.resolve();
            } catch (err) {
                w.reject(err);
            }
        }
    }
}

export class LibraryEngine {
    /**
     * @param {any} store
     * @param {bigint} nextId
     */
    constructor(store, nextId) {
        this.store = store;
        this.nextId = nextId;
        /** @type {Map<string, Promise<unknown>>} */
        this.writing = new Map();
        this.tags = new LibraryTags(this);
        this.books = new WorldInfoEngine(this);
        /** @type {Promise<void> | null} */
        this.pairsRun = null;
        this.pairsAgain = false;
        this.pairsStopped = false;
        this.batches = 0;
        this.cardCommits = new GroupedCommits(store);
        /** @type {Promise<import('./actor-ids.js').NextIds> | null} */
        this.counters = null;
    }

    /**
     * @returns {Promise<import('./actor-ids.js').NextIds>}
     */
    nextIds() {
        this.counters ??= this.store.chatRead('nextIds', {});
        return /** @type {Promise<import('./actor-ids.js').NextIds>} */ (this.counters);
    }

    beginBatch() {
        this.batches++;
    }

    endBatch() {
        this.batches = Math.max(0, this.batches - 1);
    }

    /**
     * @template T
     * @param {string} contentHash
     * @param {() => Promise<T>} write
     * @returns {Promise<T>}
     */
    importLane(contentHash, write) {
        return this.serialized(IMPORT_LANE, contentHash, write);
    }

    /**
     * @param {any} engine
     * @param {string} dir
     */
    static async open(engine, dir) {
        const store = await engine.Store.open(dir);
        return new LibraryEngine(store, await store.libraryNextId());
    }

    async close() {
        this.pairsStopped = true;
        await this.pairsRun;
        await this.tags.stopPass();
        return this.store.close();
    }

    /**
     * @returns {Promise<boolean>}
     */
    async pairsBuilt() {
        return await this.store.pairsMode() === PAIRS.indexed;
    }

    /**
     * @param {number} [pauseMs]
     * @returns {Promise<void>}
     */
    async buildPairs(pauseMs) {
        const mode = await this.store.pairsMode();
        if (mode !== PAIRS.indexing && mode !== PAIRS.indexed) await this.store.commit([{ kind: 'searchPairs', on: true }]);
        return this.runPairs(pauseMs);
    }

    /**
     * @param {number} [pauseMs]
     * @returns {Promise<void>}
     */
    runPairs(pauseMs = 10) {
        if (this.pairsRun) {
            this.pairsAgain = true;
            return this.pairsRun;
        }
        this.pairsRun = (async () => {
            try {
                do {
                    this.pairsAgain = false;
                    while (!this.pairsStopped && await this.store.pairsStep()) {
                        await new Promise(resolve => setTimeout(resolve, pauseMs));
                    }
                } while (this.pairsAgain && !this.pairsStopped);
            } finally {
                this.pairsRun = null;
            }
        })();
        return this.pairsRun;
    }

    /**
     * @template T
     * @param {number} type
     * @param {string} key
     * @param {() => Promise<T>} write
     * @returns {Promise<T>}
     */
    serialized(type, key, write) {
        const id = `${type}:${key}`;
        const before = this.writing.get(id) ?? Promise.resolve();
        const run = before.then(write, write);
        const settled = run.then(() => {}, () => {});
        this.writing.set(id, settled);
        settled.then(() => {
            if (this.writing.get(id) === settled) this.writing.delete(id);
        });
        return run;
    }

    /**
     * @param {import('./world-info-engine.js').Actor | null | undefined} actor
     * @param {object[]} records
     * @returns {Promise<() => import('./entity-values.js').Stamp>}
     */
    async stamper(actor, records) {
        const next = await this.nextIds();
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
     * @param {number} type
     * @param {string[]} keys
     * @returns {Promise<(bigint | null)[]>}
     */
    ids(type, keys) {
        return this.store.libraryIds(keys.map(k => [type, k]));
    }

    /**
     * @param {(bigint | null)[]} ids
     * @param {{ fields: (number | string)[], lists: number[] }} [only]
     * @returns {Promise<(StoredEntity | null)[]>}
     */
    async entities(ids, only) {
        const present = ids.filter(id => id !== null);
        const found = present.length > 0 ? await this.store.libraryEntities(present, only) : [];
        const byId = new Map(present.map((id, i) => [id, found[i]]));
        return ids.map(id => (id === null ? null : byId.get(id) ?? null));
    }

    /**
     * @param {number} type
     * @param {string} key
     */
    async entity(type, key) {
        const [id] = await this.ids(type, [key]);
        return id === null ? null : (await this.entities([id]))[0];
    }

    /**
     * @param {import('./users.js').UserDirectoryList} directories
     * @param {string} avatar
     * @param {string} cardJson
     * @param {object} [options]
     * @param {string | null} [options.contentHash]
     * @param {string | null} [options.avatarIdentityHash]
     * @param {number} [options.dateAdded]
     * @param {boolean} [options.fav]
     * @param {{ from: string, pastChats: boolean, at?: number }} [options.renamed]
     * @param {bigint[]} [options.tags]
     * @returns {Promise<{ id: bigint, records: number }>}
     */
    writeCard(directories, avatar, cardJson, { contentHash = null, avatarIdentityHash = null, dateAdded = Date.now(), fav, renamed, tags = [] } = {}) {
        return this.serialized(TYPE.character, avatar, async () => {
            const card = JSON.parse(cardJson);
            const stored = await this.entity(TYPE.character, avatar);
            const records = [];
            const id = stored ? stored.id : await this.newId(ownerKeyOf(avatar), records);
            if (!stored) {
                const seeded = fav ?? normalizeFav(card?.fav ?? card?.data?.extensions?.fav);
                if (seeded) records.push({ kind: 'fav', entity: id, fav: true });
            }
            const parts = splitCard(card);
            const bookAt = parts.extra.findIndex(x => x.path === 'data:character_book');
            const book = bookAt === -1 ? undefined : JSON.parse(/** @type {string} */ (parts.extra[bookAt].value));
            if (isEntryList(book)) parts.extra.splice(bookAt, 1);
            pushAll(records, (await this.books.ownedRecords(id, SLOT.characterBook, isEntryList(book) ? book : undefined)));
            const next = cardValues(parts);
            const storedLists = stored ? storedValues(stored).lists : new Map();
            const kept = storedLists.get(NAME_HISTORY) ?? [];
            const history = renamed ? renamedHistory(kept, renamed) : kept;
            if (history.length > 0) next.lists.set(NAME_HISTORY, history);
            if (storedLists.has(LIST.links)) next.lists.set(LIST.links, storedLists.get(LIST.links));
            const world = next.values.get(FIELD.world)?.text;
            const linkKey = world ? bookKey(world) : '';
            if (linkKey && world === linkKey) next.values.delete(FIELD.world);
            let identityCard = card;
            const links = storedLinks(stored);
            if (!linkKey && links.length > 1) {
                if (world === '') next.values.delete(FIELD.world);
                const name = (await this.bookNames([links[1].book])).get(links[1].book);
                if (typeof name === 'string') identityCard = _.set(_.cloneDeep(card), 'data.extensions.world', name);
            }
            records.push(...valueRecords(id, withoutStatements(stored), next));
            const { getCharaCardV2 } = await import('./character-card-normalize.js');
            const normalized = getCharaCardV2(JSON.parse(cardJson), directories, false);
            const size = calculateDataSize(normalized.data ?? {});
            if (stored?.dataSize !== size) records.push({ kind: 'dataSize', entity: id, size });
            const ms = parseCreateDateToEpochMs(normalized.create_date);
            if (!stored || (stored.createMs ?? null) !== ms) records.push({ kind: 'createDate', entity: id, ...(ms === null ? {} : { ms }) });
            const hashes = [[HASH.identity, computeContentIdentityHash(identityCard)], [HASH.content, contentHash], [HASH.avatarIdentity, avatarIdentityHash]];
            for (const [which, hex] of hashes) {
                if (hex === null) continue;
                const had = stored?.hashes.find(h => h.which === which);
                if (had && had.hash.toString('hex') === hex) continue;
                records.push({ kind: 'cardHash', entity: id, which, hash: Buffer.from(hex, 'hex') });
            }
            records.push(...this.tags.addRecords(stored ?? { id, tags: [] }, tags));
            if (!stored) records.push({ kind: 'entityCreate', entity: id, type: TYPE.character, key: avatar, added: dateAdded });
            const commit = async () => {
                records.push(...(await this.linkRecords(id, stored, linkKey)));
                if (records.length === 0) return;
                if (this.batches > 0) await this.cardCommits.commit(records);
                else await this.store.commit(records);
            };
            if (linkKey) await this.serialized(TYPE.book, linkKey, commit);
            else await commit();
            return { id, records: records.length };
        });
    }

    /**
     * @param {bigint} id
     * @param {StoredEntity | null} stored
     * @param {string} key
     * @returns {Promise<object[]>}
     */
    async linkRecords(id, stored, key) {
        const before = storedLinks(stored);
        if (!key) return before.length > 0 ? linkListRecords(id, before, before.slice(1).map(l => l.book)) : [];
        if (stored?.link?.key === key) return [];
        const records = [];
        let [book] = await this.ids(TYPE.book, [key]);
        if (book === null) {
            book = this.nextId++;
            records.push({ kind: 'entityCreate', entity: book, type: TYPE.book, key, added: Date.now() });
        }
        const rest = before.slice(1).map(l => l.book).filter(b => b !== book);
        pushAll(records, linkListRecords(id, before, [book, ...rest]));
        return records;
    }

    /**
     * @param {bigint[]} books
     * @returns {Promise<Map<bigint, string | null>>}
     */
    async bookNames(books) {
        const distinct = [...new Set(books)];
        const found = distinct.length ? await this.store.worldRead('resolved', { ids: distinct }) : [];
        return new Map(distinct.map((b, i) => [b, found[i]?.key ?? null]));
    }

    /**
     * @param {StoredEntity} e
     * @returns {Promise<string[]>}
     */
    async linkNames(e) {
        const books = storedLinks(e).map(l => l.book);
        const names = await this.bookNames(books);
        return [...new Set(books.map(b => names.get(b)).filter(n => typeof n === 'string'))];
    }

    /**
     * @param {string} avatar
     * @returns {Promise<string[]>}
     */
    async extraBookNames(avatar) {
        const [id] = await this.ids(TYPE.character, [avatar]);
        const [e] = await this.entities([id], { fields: [], lists: [LIST.links] });
        return e ? (await this.linkNames(e)).slice(1) : [];
    }

    /**
     * @returns {Promise<{ name: string, extraBooks: string[] }[]>}
     */
    async charLore() {
        const out = [];
        let after;
        for (;;) {
            const page = await this.store.worldRead('multiLinks', { after, limit: 256 });
            const entities = await this.entities(page.ids, { fields: [], lists: [LIST.links] });
            for (const e of entities) {
                if (!e) continue;
                const names = await this.linkNames(e);
                if (names.length > 1) out.push({ name: e.key.replace(/\.[^/.]+$/, ''), extraBooks: names.slice(1) });
            }
            if (!page.more || page.ids.length === 0) break;
            after = page.ids[page.ids.length - 1];
        }
        return out;
    }

    /**
     * @param {unknown} charLore
     * @returns {Promise<boolean>}
     */
    async charLoreDiffers(charLore) {
        if (!Array.isArray(charLore)) return true;
        for (let i = 0; i < charLore.length; i += 256) {
            const batch = charLore.slice(i, i + 256);
            const shaped = batch.every(x => x && typeof x.name === 'string' && Array.isArray(x.extraBooks) && x.extraBooks.every(b => typeof b === 'string'));
            if (!shaped) return true;
            const ids = await this.ids(TYPE.character, batch.map(x => `${x.name}.png`));
            const entities = await this.entities(ids, { fields: [], lists: [LIST.links] });
            for (const [n, e] of entities.entries()) {
                if (!e) return true;
                const extra = (await this.linkNames(e)).slice(1);
                if (JSON.stringify(extra) !== JSON.stringify(batch[n].extraBooks)) return true;
            }
        }
        return false;
    }

    /**
     * @param {string} avatar
     * @param {'add' | 'remove' | 'set'} op
     * @param {string[]} names
     * @returns {Promise<string[] | null>}
     */
    extraLinks(avatar, op, names) {
        return this.serialized(TYPE.character, avatar, async () => {
            const stored = await this.entity(TYPE.character, avatar);
            if (!stored) return null;
            const before = storedLinks(stored);
            const read = await this.bookNames(before.map(l => l.book));
            const keys = [...new Set(names.map(n => bookKey(n)))];
            const ids = await this.ids(TYPE.book, keys);
            const byKey = new Map(keys.map((k, i) => [k, ids[i]]));
            const nameOf = (/** @type {bigint} */ b) => read.get(b) ?? null;
            const first = before[0];
            const rest = before.slice(1);
            /** @type {bigint[]} */
            let after;
            if (op === 'remove') {
                after = [...(first ? [first.book] : []), ...rest.filter(l => !keys.includes(/** @type {string} */ (nameOf(l.book)))).map(l => l.book)];
            } else {
                const kept = op === 'add' ? rest.map(l => l.book) : rest.filter(l => keys.includes(/** @type {string} */ (nameOf(l.book)))).map(l => l.book);
                const there = new Set([...(first ? [first.book] : []), ...kept].map(nameOf));
                const added = keys.filter(k => !there.has(k)).map(k => /** @type {bigint} */ (byKey.get(k)));
                if (op === 'set') {
                    const keptByName = new Map(kept.map(b => [nameOf(b), b]));
                    after = [...(first ? [first.book] : []), ...keys.filter(k => !(first && nameOf(first.book) === k)).map(k => keptByName.get(k) ?? /** @type {bigint} */ (byKey.get(k)))];
                } else {
                    after = [...(first ? [first.book] : []), ...kept, ...added];
                }
            }
            after = [...new Set(after)];
            const records = linkListRecords(stored.id, before, after);
            if (!first && after.length > 0) {
                if (stored.values.some(v => v.field === FIELD.world)) records.unshift({ kind: 'valueDelete', entity: stored.id, field: FIELD.world });
                const key = (await this.bookNames([after[0]])).get(after[0]);
                const r = await this.identityRecord(stored, /** @type {string} */ (key));
                if (r) records.push(r);
            }
            if (records.length > 0) await this.store.commit(records);
            const now = await this.bookNames(after);
            return [...new Set(after.map(b => now.get(b)))].filter(n => typeof n === 'string' && n !== now.get(after[0])).map(String);
        });
    }

    /**
     * @param {Record<string, unknown> & { id: string }} group
     * @param {object} [options]
     * @param {number} [options.dateAdded]
     * @returns {Promise<{ id: bigint, records: number }>}
     */
    writeGroup(group, { dateAdded = Date.now() } = {}) {
        const key = String(group.id);
        return this.serialized(TYPE.group, key, async () => {
            const stored = await this.entity(TYPE.group, key);
            const records = [];
            const id = stored ? stored.id : await this.newId(key, records);
            records.push(...groupRecords(id, stored, group));
            if (!stored) records.push({ kind: 'entityCreate', entity: id, type: TYPE.group, key, added: dateAdded });
            if (records.length > 0) await this.store.commit(records);
            return { id, records: records.length };
        });
    }

    /**
     * @param {string} key
     * @param {(group: Record<string, any>) => void} change
     * @returns {Promise<boolean>}
     */
    updateGroup(key, change) {
        return this.serialized(TYPE.group, key, async () => {
            const stored = await this.entity(TYPE.group, key);
            if (!stored) return false;
            const group = { ...groupObject(stored), fav: stored.fav };
            change(group);
            const records = groupRecords(stored.id, stored, { ...group, id: key });
            if (records.length > 0) await this.store.commit(records);
            return true;
        });
    }

    /**
     * @param {string} ownerKey
     * @param {object[]} records
     * @returns {Promise<bigint>}
     */
    async newId(ownerKey, records) {
        const [tree] = await this.ids(TYPE.tree, [ownerKey]);
        if (tree === null) return this.nextId++;
        records.push({ kind: 'entityDelete', entity: tree });
        return tree;
    }

    /**
     * @param {string[]} keys
     * @returns {Promise<(Record<string, unknown> | null)[]>}
     */
    async groups(keys) {
        const entities = await this.entities(await this.ids(TYPE.group, keys));
        const present = /** @type {StoredEntity[]} */ (entities.filter(e => e !== null));
        const tagKeys = new Map((await this.tagKeys(present)).map((t, i) => [present[i].id, t]));
        return entities.map(e => (e ? { ...groupObject(e), id: e.key, fav: e.fav, tag_ids: tagKeys.get(e.id) ?? [] } : null));
    }

    /**
     * @param {number} sinceSeq
     * @param {number} limit
     * @returns {Promise<{ seq: number, changes: { id: string, op: 'upsert' | 'delete', fields?: null }[], truncated: false, hasMore: boolean }>}
     */
    async changes(sinceSeq, limit) {
        const page = await this.store.chatRead('entityChanges', { after: BigInt(Math.max(0, Math.trunc(sinceSeq))), limit });
        const live = page.entries.filter((/** @type {any} */ e) => e.gone === null);
        const keys = live.length ? await this.store.libraryKeys(live.map((/** @type {any} */ e) => e.id)) : [];
        const keyOf = new Map(live.map((/** @type {any} */ e, /** @type {number} */ i) => [e.id, keys[i]]));
        /** @type {{ id: string, op: 'upsert' | 'delete', fields?: null }[]} */
        const changes = [];
        for (const e of page.entries) {
            if (e.gone !== null) {
                if (e.gone.kind === TYPE.character) changes.push({ id: e.gone.key, op: 'delete' });
                continue;
            }
            const k = keyOf.get(e.id);
            if (k && k.type === TYPE.character) changes.push({ id: k.key, op: 'upsert', fields: null });
        }
        const last = page.entries.length ? Number(page.entries[page.entries.length - 1].pos) : null;
        return { seq: last ?? Math.max(Math.trunc(sinceSeq), Number(page.end)), changes, truncated: false, hasMore: page.more };
    }

    /**
     * @returns {Promise<number>}
     */
    async changesEnd() {
        return Number((await this.store.chatRead('entityChanges', { after: 0n, limit: 0 })).end);
    }

    /**
     * @param {{ name?: string | null, allowAvatar?: boolean, insensitive?: boolean, tags?: string[] | null }} q
     * @returns {Promise<{ ids: string[], capped: boolean }>}
     */
    async findCharacters({ name = null, allowAvatar = true, insensitive = true, tags = null }) {
        const hasName = typeof name === 'string' && name !== '';
        const tagNames = Array.isArray(tags) && tags.length > 0 ? tags.map(String) : null;
        /** @type {string[]} */
        let tagKeys = [];
        /** @type {(bigint | null)[]} */
        let wanted = [];
        if (tagNames) {
            const byName = new Map((await this.tags.findByNames(tagNames)).map(f => [f.name, f.tag]));
            const tags = tagNames.map(n => byName.get(n));
            if (tags.some((t, i) => !t || t.name !== tagNames[i])) return { ids: [], capped: false };
            tagKeys = tags.map(t => /** @type {{ id: string }} */ (t).id);
            wanted = await this.ids(TYPE.tag, tagKeys);
            if (wanted.some(t => t === null)) return { ids: [], capped: false };
        }
        /** @param {bigint[]} ids */
        const withTags = async ids => {
            if (!tagNames || ids.length === 0) return ids;
            const carried = await this.store.libraryTagIds(ids);
            return ids.filter((_, i) => wanted.every(t => (carried[i] ?? []).includes(t)));
        };
        if (allowAvatar && hasName) {
            for (const avatar of name.endsWith('.png') ? [name] : [name, `${name}.png`]) {
                const [id] = await this.ids(TYPE.character, [avatar]);
                if (id !== null && (await withTags([id])).length > 0) return { ids: [avatar], capped: false };
            }
        }
        if (hasName) {
            const nameKey = tagNameKey(name);
            const candidates = await this.store.chatRead('libraryNamed', { type: TYPE.character, name, limit: FIND_WORK_CAP + 1 });
            const capped = candidates.length > FIND_WORK_CAP;
            const read = candidates.slice(0, FIND_WORK_CAP);
            const entities = await this.entities(read.map((/** @type {any} */ c) => c.id), { fields: [FIELD.name], lists: [] });
            const named = entities.filter(e => {
                if (!e) return false;
                const v = e.values.find(x => x.field === FIELD.name);
                const candidate = v === undefined ? '' : String(v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json)));
                return insensitive && candidate !== '' ? tagNameKey(candidate) === nameKey : candidate === name;
            }).map(e => /** @type {StoredEntity} */ (e));
            const kept = new Set(await withTags(named.map(e => e.id)));
            const found = named.filter(e => kept.has(e.id)).map(e => e.key).sort();
            return { ids: found.slice(0, 2), capped: capped && found.length < 2 };
        }
        const page = await this.query({ tags: tagNames ? { include: tagKeys } : undefined, sortField: 'name', sortOrder: 'asc', limit: FIND_WORK_CAP, wantRows: false, wantHashes: true, groupsOnly: false, includeGroups: false });
        const found = /** @type {{ id: string }[]} */ (page.hashRows).map(r => r.id).sort();
        return { ids: found.slice(0, 2), capped: Boolean(page.more) && found.length < 2 };
    }

    /**
     * @param {string} name
     * @returns {Promise<string[]>}
     */
    async findGroups(name) {
        const key = tagNameKey(String(name));
        const candidates = await this.store.chatRead('libraryNamed', { type: TYPE.group, name: String(name), limit: FIND_WORK_CAP });
        const groups = await this.groups((await this.store.libraryKeys(candidates.map((/** @type {any} */ c) => c.id))).filter(Boolean).map((/** @type {any} */ k) => k.key));
        return groups.filter(g => g && tagNameKey(String(g.name)) === key).map(g => /** @type {any} */ (g).id).sort().slice(0, 2);
    }

    /**
     * @param {string[]} paths
     * @returns {Promise<Map<string, number>>}
     */
    async localImportMtimes(paths) {
        /** @type {Map<string, number>} */
        const out = new Map();
        if (paths.length === 0) return out;
        const found = await this.store.chatRead('localImportMtimes', { paths });
        paths.forEach((p, i) => {
            if (found[i]) out.set(p, found[i].mtime);
        });
        return out;
    }

    /**
     * @param {string} path
     * @param {number} mtimeMs
     * @param {string | null} [duplicateOf]
     */
    async setLocalImportMtime(path, mtimeMs, duplicateOf = null) {
        const dup = duplicateOf === null ? null : (await this.ids(TYPE.character, [duplicateOf]))[0];
        const [now] = await this.store.chatRead('localImportMtimes', { paths: [path] });
        if (now && now.mtime === mtimeMs && (now.duplicateOf ?? null) === dup) return;
        await this.store.commit([{ kind: 'localImportMtime', path, mtime: mtimeMs, ...(dup === null ? {} : { duplicateOf: dup }) }]);
    }

    /** @param {string} path */
    async clearLocalImportMtime(path) {
        const [now] = await this.store.chatRead('localImportMtimes', { paths: [path] });
        if (now) await this.store.commit([{ kind: 'localImportMtime', path }]);
    }

    /**
     * @param {string} after
     * @param {number} limit
     * @returns {Promise<string[]>}
     */
    localImportPathsAfter(after, limit) {
        return this.store.chatRead('localImportPaths', { ...(after === '' ? {} : { after }), limit });
    }

    /**
     * @param {string} path
     * @returns {Promise<{ mtimeMs: number, reason: string } | null>}
     */
    async localImportSkip(path) {
        const found = await this.store.chatRead('localImportSkip', { path });
        return found === null ? null : { mtimeMs: found.mtime, reason: found.reason };
    }

    /**
     * @param {string} path
     * @param {number} mtimeMs
     * @param {string} reason
     */
    async setLocalImportSkip(path, mtimeMs, reason) {
        const now = await this.localImportSkip(path);
        if (now && now.mtimeMs === mtimeMs && now.reason === reason) return;
        await this.store.commit([{ kind: 'localImportSkip', path, mtime: mtimeMs, reason, checked: Date.now() }]);
    }

    /** @param {string} path */
    async clearLocalImportSkip(path) {
        if (await this.localImportSkip(path)) await this.store.commit([{ kind: 'localImportSkip', path }]);
    }

    /**
     * @param {bigint[]} ids
     * @returns {Promise<Map<bigint, { date_last_chat: number, chat_size: number }>>}
     */
    async chatStats(ids) {
        /** @type {Map<bigint, { date_last_chat: number, chat_size: number }>} */
        const out = new Map();
        if (ids.length === 0) return out;
        const { owners } = await this.store.chatRead('stats', { owners: ids });
        ids.forEach((id, i) => out.set(id, { date_last_chat: owners[i]?.lastAt ?? 0, chat_size: owners[i]?.chatSize ?? 0 }));
        return out;
    }

    /**
     * @param {string} avatar
     * @param {boolean} allowed
     * @returns {Promise<boolean>}
     */
    setAllowGlobalStyles(avatar, allowed) {
        return this.serialized(TYPE.character, avatar, async () => {
            const stored = await this.entity(TYPE.character, avatar);
            if (!stored) return false;
            const json = JSON.stringify(!!allowed);
            if (stored.values.find(v => v.field === FIELD.allow_global_styles)?.json !== json) {
                await this.store.commit([{ kind: 'jsonValue', entity: stored.id, field: FIELD.allow_global_styles, json }]);
            }
            return true;
        });
    }

    /**
     * @param {number} type
     * @param {string} key
     * @param {{ key?: string, dateAdded?: number }} change
     * @returns {Promise<boolean>}
     */
    updateEntity(type, key, change) {
        return this.serialized(type, key, async () => {
            const stored = await this.entity(type, key);
            if (!stored) return false;
            const next = { key: change.key ?? stored.key, added: change.dateAdded ?? stored.added };
            if (next.key === stored.key && next.added === stored.added) return true;
            if (next.key !== stored.key && (await this.ids(type, [next.key]))[0] !== null) return false;
            await this.store.commit([{ kind: 'entityUpdate', entity: stored.id, type, key: next.key, added: next.added }]);
            return true;
        });
    }

    /**
     * @param {number} which
     * @param {string | null} hex
     * @returns {Promise<string | null>}
     */
    async findByHash(which, hex) {
        if (hex === null) return null;
        const [id] = await this.store.libraryByHash(which, Buffer.from(hex, 'hex'), 1);
        return id === undefined ? null : (await this.entities([id]))[0]?.key ?? null;
    }

    /**
     * @param {string | null} contentIdentityHash
     * @param {string | null} avatarIdentityHash
     * @returns {Promise<string | null>}
     */
    async findByIdentityHashes(contentIdentityHash, avatarIdentityHash) {
        if (contentIdentityHash === null || avatarIdentityHash === null) return null;
        const [id] = await this.store.libraryByHashes(HASH.identity, Buffer.from(contentIdentityHash, 'hex'), HASH.avatarIdentity, Buffer.from(avatarIdentityHash, 'hex'), 1);
        return id === undefined ? null : (await this.entities([id]))[0]?.key ?? null;
    }

    /**
     * @param {number} type
     * @param {string} key
     * @param {boolean} fav
     * @returns {Promise<boolean | null>}
     */
    setFav(type, key, fav) {
        return this.serialized(type, key, async () => {
            const stored = await this.entity(type, key);
            if (!stored) return null;
            if (stored.fav === fav) return false;
            await this.store.commit([{ kind: 'fav', entity: stored.id, fav }]);
            return true;
        });
    }

    /**
     * @param {{ id: string, name?: string, folder_type?: string, [key: string]: unknown }} tag
     * @param {object} [options]
     * @param {(id: bigint) => object[]} [options.extra]
     * @returns {Promise<bigint>}
     */
    writeTag(tag, { extra } = {}) {
        return this.serialized(TYPE.tag, tag.id, async () => {
            const { id, records } = await this.tagRecords(tag);
            if (extra) records.push(...extra(id));
            if (records.length > 0) await this.store.commit(records);
            return id;
        });
    }

    /**
     * @param {{ id: string, [key: string]: unknown }} tag
     * @returns {Promise<{ id: bigint, records: object[] }>}
     */
    async tagRecords(tag) {
        const stored = await this.entity(TYPE.tag, tag.id);
        const id = stored ? stored.id : this.nextId++;
        /** @type {Map<number | string, { text?: string, json?: string }>} */
        const values = new Map();
        for (const [k, v] of Object.entries(tag)) {
            if (k === 'id' || v === undefined) continue;
            const field = k === 'name' ? FIELD.name : k === 'folder_type' ? FIELD.folder_type : `${TAG_KEY_PREFIX}${k}`;
            values.set(field, typeof v === 'string' && typeof field === 'number' ? { text: v } : { json: JSON.stringify(v) });
        }
        values.set(FIELD.defined, { json: '' });
        const records = valueRecords(id, stored, { values, lists: new Map() });
        const marker = records.findIndex(r => /** @type {any} */ (r).field === FIELD.defined);
        const order = tagDerivedColumns(tag).sortOrder;
        if ((stored?.tagOrder ?? null) !== order) {
            records.splice(marker === -1 ? records.length : marker, 0, { kind: 'tagOrder', tag: id, ...(order === null ? {} : { order }) });
        }
        if (!stored) records.push({ kind: 'entityCreate', entity: id, type: TYPE.tag, key: tag.id, added: Date.now() });
        return { id, records };
    }

    /**
     * @param {number} type
     * @param {string} key
     * @param {string} tagKey
     * @param {boolean} assigned
     * @returns {Promise<boolean>}
     */
    async assignTag(type, key, tagKey, assigned) {
        const [entity] = await this.ids(type, [key]);
        const [tag] = await this.ids(TYPE.tag, [tagKey]);
        if (entity === null || tag === null) return false;
        await this.store.commit([{ kind: 'tagAssign', entity, tag, assigned }]);
        return true;
    }

    /**
     * @param {string} tagKey
     * @param {string | null} intoKey
     */
    async deleteTag(tagKey, intoKey = null) {
        const [tag] = await this.ids(TYPE.tag, [tagKey]);
        if (tag === null) return false;
        const into = intoKey === null ? null : (await this.ids(TYPE.tag, [intoKey]))[0];
        await this.store.commit([
            { kind: 'tagMerge', tag, ...(into === null ? {} : { into }) },
            { kind: 'entityDelete', entity: tag },
        ]);
        return true;
    }

    /**
     * @param {number} type
     * @param {string} key
     * @param {{ keepChats?: boolean }} [options]
     */
    deleteEntity(type, key, { keepChats = false } = {}) {
        return this.serialized(type, key, async () => {
            const [id] = await this.ids(type, [key]);
            if (id === null) return false;
            const book = type === TYPE.character ? await this.books.ownedRecords(id, SLOT.characterBook, undefined) : [];
            /** @type {object[]} */
            const records = [...book, { kind: 'entityDelete', entity: id }];
            if (keepChats && (type === TYPE.character || type === TYPE.group) && await this.holdsChats(id)) {
                records.push({ kind: 'entityCreate', entity: id, type: TYPE.tree, key: type === TYPE.character ? ownerKeyOf(key) : key, added: Date.now() });
            }
            await this.store.commit(records);
            return true;
        });
    }

    /**
     * @param {bigint} tree
     */
    async holdsChats(tree) {
        const children = await this.store.chatRead('children', { tree, limit: 1 });
        if (children.ids.length > 0) return true;
        return (await this.store.chatRead('treeBookmarks', { tree, limit: 1 })).length > 0;
    }

    /**
     * @param {string[]} avatars
     * @returns {Promise<(unknown | null)[]>}
     */
    async cards(avatars) {
        const entities = await this.entities(await this.ids(TYPE.character, avatars));
        return Promise.all(entities.map(e => (e ? this.assembled(e) : null)));
    }

    /**
     * @param {StoredEntity} e
     */
    async assembled(e) {
        const parts = cardParts(e);
        const book = await this.books.owned(e.id, SLOT.characterBook);
        if (book !== undefined) parts.extra.push({ path: 'data:character_book', value: JSON.stringify(book) });
        return assembleCard(parts);
    }

    /**
     * @param {StoredEntity} e
     * @param {string} world
     * @returns {Promise<object | null>}
     */
    async identityRecord(e, world) {
        const values = e.link ? e.values : e.values.filter(v => v.field !== FIELD.world);
        const card = await this.assembled({ ...e, values, link: { book: e.link?.book ?? 0n, version: e.link?.version ?? 0n, key: world } });
        const hex = computeContentIdentityHash(card);
        if (e.hashes.find(h => h.which === HASH.identity)?.hash.toString('hex') === hex) return null;
        return { kind: 'cardHash', entity: e.id, which: HASH.identity, hash: Buffer.from(hex, 'hex') };
    }

    /**
     * @param {bigint[]} ids
     * @param {string} world
     * @param {string[]} reading
     * @returns {Promise<object[]>}
     */
    async identityRecords(ids, world, reading) {
        const records = [];
        for (let i = 0; i < ids.length; i += 256) {
            const entities = await this.entities(ids.slice(i, i + 256));
            for (const e of entities) {
                if (!e || e.type !== TYPE.character || !e.link || !reading.includes(e.link.key)) continue;
                const r = await this.identityRecord(e, world);
                if (r) records.push(r);
            }
        }
        return records;
    }

    /**
     * @param {StoredEntity[]} entities
     * @returns {Promise<string[][]>}
     */
    async tagKeys(entities) {
        const tagIds = [...new Set(entities.flatMap(e => e.tags))];
        const tags = tagIds.length > 0 ? await this.store.libraryKeys(tagIds) : [];
        const keyOf = new Map(tagIds.map((t, i) => [t, tags[i]?.key]));
        return entities.map(e => normalizeTagIds(e.tags.map(t => keyOf.get(t)).filter(k => k !== undefined)));
    }

    /**
     * @param {StoredEntity[]} entities
     * @param {boolean} includeCreatorNotes
     */
    async listRows(entities, includeCreatorNotes) {
        const tagKeys = await this.tagKeys(entities);
        const stats = await this.chatStats(entities.map(e => e.id));
        return entities.map((e, i) => {
            const card = assembleCard(cardParts(e));
            const values = cardListValues(card, includeCreatorNotes);
            /** @type {Record<string, unknown>} */
            const row = { shallow: true };
            if (values.name !== undefined) row.name = values.name;
            row.avatar = e.key;
            row.fav = e.fav;
            row.date_added = e.added;
            if (values.create_date !== undefined) row.create_date = values.create_date;
            row.date_last_chat = stats.get(e.id)?.date_last_chat ?? 0;
            row.chat_size = stats.get(e.id)?.chat_size ?? 0;
            row.data_size = e.dataSize ?? 0;
            if (values.tags !== undefined) row.tags = values.tags;
            row.tag_ids = tagKeys[i];
            const { world, ...dataValues } = values.data;
            row.data = { ...dataValues, extensions: { fav: e.fav, world } };
            const allow = e.values.find(v => v.field === FIELD.allow_global_styles);
            if (allow?.json !== undefined) row.allow_global_styles = !!JSON.parse(allow.json);
            return row;
        });
    }

    /**
     * @param {object} params
     * @param {{ include?: string[], exclude?: string[], mode?: 'and' | 'or' }} [params.tags]
     * @param {boolean} [params.fav]
     * @param {string} [params.world]
     * @param {Record<string, { min?: number, max?: number }>} [params.ranges]
     * @param {string[]} [params.excludeIds]
     * @param {string[]} [params.ids]
     * @param {string} [params.sortField]
     * @param {'asc' | 'desc'} [params.sortOrder]
     * @param {number} [params.seed]
     * @param {string} [params.tieSortField]
     * @param {'asc' | 'desc'} [params.tieSortOrder]
     * @param {number} [params.tieSeed]
     * @param {number} [params.offset]
     * @param {number} [params.limit]
     * @param {string} [params.cursor]
     * @param {boolean} [params.wantRows]
     * @param {boolean} [params.wantTotal]
     * @param {boolean} [params.wantHashes]
     * @param {boolean} [params.groupsOnly]
     * @param {boolean} [params.includeGroups]
     * @param {boolean} [params.includeCreatorNotes]
     * @param {boolean} [params.wantHidden]
     * @param {{ characters: boolean, groups: boolean }} [params.hiddenKinds]
     * @param {number} [params.cap]
     * @param {string} [params.search]
     */
    async query(params) {
        const { tags, fav, world, ranges, excludeIds, ids, sortField, sortOrder, seed, tieSortField, tieSortOrder, tieSeed, offset = 0, limit = 500, cursor, wantRows = true, wantTotal = true, wantHashes = false, wantHidden = false, groupsOnly = false, includeGroups = true, includeCreatorNotes = false, cap = 20_000, search } = params;
        const hiddenKinds = params.hiddenKinds ?? { characters: !groupsOnly, groups: groupsOnly || includeGroups };
        const clauses = typeof search === 'string' ? searchClauses(search, LIBRARY_LABELS) : [];
        const hiddenOf = async (/** @type {number} */ shown) => {
            if (!wantHidden) return {};
            const all = await this.store.libraryPage({ ...hiddenKinds, count: true, limit: 0, cap, sort: { key: SORT_KEYS.name, desc: false } });
            return { hidden: Math.max(0, Number(all.total) - shown), approxHidden: !all.totalExact };
        };
        const include = (tags?.include ?? []).filter(Boolean).map(String);
        const exclude = (tags?.exclude ?? []).filter(Boolean).map(String);
        const tagIds = new Map();
        const tagKeys = [...new Set([...include, ...exclude, ...Object.keys(ranges ?? {}).filter(k => k.startsWith('tag:')).map(k => k.slice(4))])];
        const statuses = /** @type {({ id: bigint, state: string, into?: string } | null)[]} */ (tagKeys.length > 0 ? await this.store.tagStatus(tagKeys) : []);
        const intoKeys = [...new Set(statuses.flatMap(s => (s?.state === 'gone' && s.into !== undefined ? [s.into] : [])))];
        const intoIds = new Map(/** @type {any[]} */ (intoKeys.length > 0 ? await this.store.tagStatus(intoKeys) : []).map((s, i) => [intoKeys[i], s?.id ?? null]));
        statuses.forEach((s, i) => tagIds.set(tagKeys[i], s?.state === 'gone' ? (s.into === undefined ? null : intoIds.get(s.into) ?? null) : s?.id ?? null));
        const known = (/** @type {string[]} */ keys) => keys.map(k => tagIds.get(k)).filter(t => t !== null && t !== undefined);
        /** @type {Record<string, unknown>} */
        const q = {
            characters: !groupsOnly,
            groups: groupsOnly || includeGroups,
            count: wantTotal,
            offset: Math.max(0, Math.trunc(Number(offset) || 0)),
            limit: Math.max(0, Math.trunc(Number(limit) || 0)),
            cap,
        };
        if (typeof fav === 'boolean') q.fav = fav;
        if (include.length > 0) {
            const found = known(include);
            if (tags?.mode === 'or') q.anyTags = found.length > 0 ? found : [0n];
            else q.allTags = found.length === include.length ? found : [0n];
        }
        if (exclude.length > 0) q.noTags = known(exclude);
        if (typeof world === 'string' && world) q.world = bookKey(world);
        const keyIds = async (/** @type {string[]} */ keys) => {
            const types = groupsOnly ? [TYPE.group] : includeGroups ? [TYPE.character, TYPE.group] : [TYPE.character];
            const out = [];
            for (const type of types) out.push(...(await this.ids(type, keys)).filter(id => id !== null));
            return out;
        };
        if (Array.isArray(ids)) {
            if (ids.length === 0) return { rows: wantRows ? [] : undefined, hashRows: wantHashes ? [] : undefined, total: wantTotal ? 0 : undefined, approxTotal: false, ...(await hiddenOf(0)) };
            q.ids = await keyIds(ids.map(String));
            if (q.ids.length === 0) q.ids = [0n];
        }
        if (Array.isArray(excludeIds) && excludeIds.length > 0) q.notIds = await keyIds(excludeIds.map(String));
        if (ranges) {
            q.ranges = Object.entries(ranges).map(([field, b]) => ({
                field: field.startsWith('tag:') ? (tagIds.get(field.slice(4)) ?? 0n) : field,
                ...(typeof b.min === 'number' ? { min: b.min } : {}),
                ...(typeof b.max === 'number' ? { max: b.max } : {}),
            }));
        }
        const relevance = clauses.length > 0 && sortField === 'search';
        q.sort = relevance ? listSort(tieSortField, tieSortOrder, tieSeed) : listSort(sortField, sortOrder, seed);
        const order = Buffer.from(JSON.stringify(q.sort)).toString('base64url');
        if (typeof cursor === 'string' && cursor.startsWith('e')) {
            const dot = cursor.indexOf('.');
            if (relevance || dot === -1 || cursor.slice(1, dot) !== order) return 'invalid-cursor';
            q.cursor = Buffer.from(cursor.slice(dot + 1), 'base64url');
        } else if (typeof cursor === 'string' && /^[stb]/.test(cursor) && !relevance) {
            return 'invalid-cursor';
        }
        let page;
        if (clauses.length > 0) {
            const after = relevance && typeof cursor === 'string' ? parseRelevanceCursor(cursor, order) : null;
            if (after === 'invalid') return 'invalid-cursor';
            let s;
            try {
                s = await this.store.librarySearch({ ...q, clauses, relevance, ...(after ? { after } : {}) });
            } catch (err) {
                if (after && /^invalid cursor/.test(String(/** @type {any} */ (err)?.message))) return 'invalid-cursor';
                throw err;
            }
            const relevanceCursor = relevance && s.more && s.next ? relevanceCursorOf(s.next, order) : undefined;
            page = { ...s, cursor: relevance ? undefined : s.cursor, relevanceCursor, more: relevance ? false : s.more };
        } else {
            page = await this.store.libraryPage(q);
        }
        const read = wantRows && !wantHashes ? listRowValues(includeCreatorNotes) : NO_VALUES;
        const pageEntities = /** @type {StoredEntity[]} */ ((await this.entities(page.ids, read)).filter(e => e !== null));
        const out = {
            total: wantTotal ? page.total : undefined,
            approxTotal: wantTotal ? !page.totalExact : false,
            ...(page.cursor ? { cursor: `e${order}.${page.cursor.toString('base64url')}` } : {}),
            ...(page.relevanceCursor ? { cursor: page.relevanceCursor } : {}),
            ...(page.more ? { more: true } : {}),
        };
        const groups = /** @type {StoredEntity[]} */ ((await this.entities(pageEntities.filter(e => e.type === TYPE.group).map(e => e.id))).filter(e => e !== null));
        const groupOf = new Map(groups.map(g => [g.id, g]));
        const entities = pageEntities.filter(e => e.type !== TYPE.group || groupOf.has(e.id));
        const groupTags = new Map((await this.tagKeys(groups)).map((t, i) => [groups[i].id, t]));
        const pageCharacters = entities.filter(e => e.type !== TYPE.group);
        const characterTags = wantHashes ? new Map((await this.tagKeys(pageCharacters)).map((t, i) => [pageCharacters[i].id, t])) : new Map();
        const stats = await this.chatStats(entities.map(e => e.id));
        const statsOf = (/** @type {bigint} */ id) => stats.get(id) ?? { date_last_chat: 0, chat_size: 0 };
        if (wantHashes) {
            const hashRows = entities.map(e => this.hashRow(groupOf.get(e.id) ?? e, groupTags.get(e.id) ?? characterTags.get(e.id) ?? [], statsOf(e.id)));
            return { ...out, rows: undefined, hashRows, ...(await hiddenOf(hashRows.length)) };
        }
        if (!wantRows) return { ...out, rows: undefined, hashRows: undefined, ...(await hiddenOf(0)) };
        const characters = entities.filter(e => e.type === TYPE.character);
        const listRows = new Map((await this.listRows(characters, includeCreatorNotes)).map((r, i) => [characters[i].id, r]));
        const rows = entities.map(e => ({
            type: e.type === TYPE.group ? 'group' : 'character',
            id: e.key,
            fav: e.fav,
            date_added: e.added,
            ...statsOf(e.id),
            item: e.type === TYPE.group
                ? { ...groupObject(groupOf.get(e.id) ?? e), fav: e.fav, date_added: e.added, ...statsOf(e.id), tag_ids: groupTags.get(e.id) ?? [] }
                : listRows.get(e.id) ?? null,
        }));
        return { ...out, hashRows: undefined, rows, ...(await hiddenOf(rows.length)) };
    }

    /**
     * @param {StoredEntity} e
     * @param {string[]} tagKeys
     * @param {{ date_last_chat: number, chat_size: number }} stats
     */
    hashRow(e, tagKeys, stats) {
        const row = {
            id: e.key,
            isGroup: e.type === TYPE.group,
            chat: null,
            date_added: e.added,
            create_date: e.type === TYPE.group ? e.added : (e.createMs ?? null),
            date_last_chat: stats.date_last_chat,
            chat_size: stats.chat_size,
            data_size: e.dataSize ?? 0,
            version: e.type === TYPE.group ? null : Number(e.link && e.link.version > e.version ? e.link.version : e.version),
            favHash: 0,
            tagIdsHash: 0,
            contentHash: 0,
        };
        if (e.type === TYPE.group) {
            const group = { ...groupObject(e), id: e.key, fav: e.fav, tag_ids: tagKeys };
            row.favHash = groupDigestFavHash(group) >>> 0;
            row.tagIdsHash = groupDigestTagIdsHash(group) >>> 0;
            row.contentHash = groupDigestContentHash(group) >>> 0;
        } else {
            row.tagIdsHash = groupDigestTagIdsHash({ tag_ids: tagKeys }) >>> 0;
        }
        return row;
    }
}
