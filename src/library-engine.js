import { CARD_COLUMNS, assembleCard, splitCard } from './character-card-storage.js';
import { computeContentIdentityHash } from './card-identity-hash.js';
import { LIST_CREATOR_NOTES_PATHS, LIST_EXTRA_PATHS, cardListValues } from './card-list-values.js';
import { calculateDataSize } from './character-shallow.js';
import { parseCreateDateToEpochMs } from './util.js';
import { tagDerivedColumns } from './tag-order.js';
import { LibraryTags } from './library-engine-tags.js';
import { textEdit, wtf8Length } from './text-edit.js';
import { itemField, pushAll, storedValues, valueRecords } from './entity-values.js';
import { FIELD, NAME_HISTORY, TAG_KEY_PREFIX, TYPE, renameItem, renamesOf } from './library-codes.js';
import { bookKey } from './world-info-keys.js';
import { LIBRARY_LABELS, cursorWeights, cursorWeightsOf, searchClauses } from './search-clauses.js';
import { SLOT, WorldInfoEngine, isEntryList } from './world-info-engine.js';
import { groupDigestContentHash, groupDigestFavHash, groupDigestTagIdsHash, normalizeFav, normalizeTagIds, tagNameKey } from '../public/scripts/hash-utils.js';

/**
 * The library on the engine: characters, groups and tags as entities whose values are the engine's records.
 *
 * A card is stored as splitCard() splits it, each part its own value: the known text fields as text values, other
 * known values and every extension key and other path as JSON (a marker as empty JSON), greetings and the card's
 * own tag names as list items. A write records only the values that differ from the stored ones: a changed text as
 * one edit, a list by its changed items. The sort keys the app computes with its own functions (the data size, the
 * create date as a time, the content identity hash) are recorded with the card whenever they change.
 */

export { FIELD, TAG_KEY_PREFIX, TYPE, textEdit, wtf8Length, itemField, valueRecords };

/** @typedef {import('./entity-values.js').StoredEntity} StoredEntity */

/** List codes. */
export const LIST = Object.freeze({ alternate_greetings: 0, group_only_greetings: 1, tags: 2, nameHistory: NAME_HISTORY });

/** A group's field codes; its other keys are stored by key, `group:<key>`. */
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

/** A group's lists: a non-empty list of strings is stored as items, any other value as JSON under its key. */
export const GROUP_LIST = Object.freeze({ members: 3, disabled_members: 4 });

const GROUP_KEY_PREFIX = 'group:';

/**
 * A group object's keys that aren't values of its own: the id is its key, `fav` its fav record and `tag_ids` its
 * tag assignments; the dates and chat activity are the library's, and `chat_id` and `chats` are the sessions in its
 * tree.
 */
const GROUP_READ_KEYS = new Set(['id', 'fav', 'tag_ids', 'date_added', 'create_date', 'date_last_chat', 'chat_size', 'chat_id', 'chats']);

/**
 * The owner key a character's chats were kept under before the engine (upstream's chats folder name): an unowned
 * tree with this key is the character's once it is created.
 * @param {string} avatar
 */
export function ownerKeyOf(avatar) {
    return String(avatar).replace('.png', '');
}

/** `cardHash` kinds. */
export const HASH = Object.freeze({ identity: 0, content: 1, avatarIdentity: 3 });

/**
 * A relevance page's cursor as the engine's `after`: `s<rank>:<entity>` (the page ended at that hit),
 * `t<rank>:<order>.<list cursor>` (among the matches tied at that rank, ordered by `order`), `b<rank>` (past
 * those), each followed by `:<idf>,<idf>,…` when the query has several words (the idfs page 1 ranked by, so every
 * page ranks alike). A rank is a hit's place in the order: one word's score before its idf, which cards added or
 * removed don't move; else the score. A tied cursor made in another order is refused (`'invalid'`).
 * @param {string} cursor
 * @param {string} order The page's tie order (`order` as list cursors name it).
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
 * The engine's `next` of a relevance page as a cursor (see `parseRelevanceCursor`).
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
 * A list sort as the engine takes it.
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

/** The pair postings' modes (`search::pairs`; 0 is off). */
const PAIRS = Object.freeze({ building: 1, on: 2, deleting: 3 });

/** Sort key codes of `Store.libraryPage`. */
export const SORT_KEYS = Object.freeze({ name: 0, create_date: 1, date_added: 2, date_last_chat: 3, chat_size: 4, data_size: 5 });

const EXTENSION_PREFIX = 'ext:';

/**
 * The values a character's list row is made from (the old store's `listRowsFromFieldsSync()` reads the same): its
 * name, creator, version, lorebook and create date, the few paths and the extension those can be in, its card tags,
 * and creator notes when the list shows them.
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

/** No values: an entity's key, dates, sizes, fav, tags, link and version. */
const NO_VALUES = Object.freeze({ fields: [], lists: [] });

/**
 * A card's parts as the values and lists the engine stores.
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
 * A character's rename history items (`renameItem()`) after a rename from `renamed.from`, given those it has.
 * @param {string[]} items
 * @param {{ from: string, pastChats: boolean, at?: number }} renamed
 * @returns {string[]}
 */
function renamedHistory(items, { from, pastChats, at = Date.now() }) {
    if (pastChats) return [];
    // Entries stay in time order even if the clock stepped back.
    const until = Math.max(at, renamesOf(items.slice(-1))[0]?.until ?? 0);
    return [...items, renameItem({ until, name: from })];
}

const CODE_NAMES = new Map(Object.entries(FIELD).map(([k, v]) => [v, k]));
const LIST_NAMES = new Map(Object.entries(LIST).map(([k, v]) => [v, k]));

/**
 * An engine entity's values as a card's parts, the inverse of cardValues().
 * @param {StoredEntity} entity
 * @returns {import('./character-card-storage.js').CardParts}
 */
export function cardParts(entity) {
    /** @type {import('./character-card-storage.js').CardParts} */
    const parts = { columns: {}, card: {}, greetings: [], tags: [], extensions: [], extra: [] };
    const { values, lists } = storedValues(entity);
    for (const [field, v] of values) {
        if (typeof field === 'string') {
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
    // A lorebook linked by id reads as the name of the book it resolves as; a card's own text is kept only where
    // it differs from that name.
    if (parts.columns.world === undefined && entity.link) parts.columns.world = entity.link.key;
    parts.columns.fav = entity.fav;
    return parts;
}

const GROUP_CODE_NAMES = new Map(Object.entries(GROUP_FIELD).map(([k, v]) => [v, k]));
const GROUP_LIST_NAMES = new Map(Object.entries(GROUP_LIST).map(([k, v]) => [v, k]));

/**
 * A group object's own values and lists, as the engine stores them.
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
 * The records turning a stored group (none: a new one) into `group`: its fav (normalizeFav()) and its own values.
 * @param {bigint} id
 * @param {StoredEntity | null} stored
 * @param {Record<string, unknown>} group
 */
function groupRecords(id, stored, group) {
    const records = [];
    const fav = normalizeFav(group.fav);
    if (stored ? stored.fav !== fav : fav) records.push({ kind: 'fav', entity: id, fav });
    records.push(...valueRecords(id, stored, groupValues(group)));
    return records;
}

/**
 * A stored group's object: its id and its own values, the inverse of groupValues().
 * @param {StoredEntity} entity
 * @returns {Record<string, unknown>}
 */
export function groupObject(entity) {
    const { values, lists } = storedValues(entity);
    /** @type {Record<string, unknown>} */
    const group = { id: entity.key };
    // A key such as `__proto__` is set as the group's own property, as JSON.parse() gave it.
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

/** Entities `findCharacters()` reads at most before it answers with what it found. */
export const FIND_WORK_CAP = 20000;

/**
 * The library of one user's store.
 */
/** The lane type of an import's upload content hash, beside the entity types' lanes. */
const IMPORT_LANE = -1;

/** Records a grouped commit holds at most. */
const GROUP_RECORDS = 4000;

/**
 * Commits writes together: a write waiting while a commit is under way goes in the next one, so a lone write is sent
 * at once and writes arriving together share a commit. A refused commit (which writes nothing) is retried one write
 * at a time, so one write's refusal fails only that write.
 */
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
     * @returns {Promise<void>} Once they are durable.
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
     * @param {any} store The engine's `Store`.
     * @param {bigint} nextId
     */
    constructor(store, nextId) {
        this.store = store;
        this.nextId = nextId;
        /** @type {Map<string, Promise<unknown>>} */
        this.writing = new Map();
        this.tags = new LibraryTags(this);
        this.books = new WorldInfoEngine(this);
        /** @type {Promise<void> | null} The pair postings' pass being run. */
        this.pairsRun = null;
        this.pairsAgain = false;
        this.pairsStopped = false;
        /** Open batch imports (`beginBatch()` less `endBatch()`). */
        this.batches = 0;
        this.cardCommits = new GroupedCommits(store);
    }

    /**
     * Opens a batch import: until it ends, card writes are committed together, the cards whose writes are waiting
     * while a commit is under way in the next one. Each write still answers only once its card is durable.
     */
    beginBatch() {
        this.batches++;
    }

    endBatch() {
        this.batches = Math.max(0, this.batches - 1);
    }

    /**
     * Runs `write` after every earlier one given the same upload content hash: an import's duplicate check and its
     * write, so an identical file sent alongside finds the first stored.
     * @template T
     * @param {string} contentHash
     * @param {() => Promise<T>} write
     * @returns {Promise<T>}
     */
    importLane(contentHash, write) {
        return this.serialized(IMPORT_LANE, contentHash, write);
    }

    /**
     * @param {any} engine The engine binding.
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
     * The pair postings option (quoted phrases searched faster, more disk): whether it is on, and whether its
     * build or delete is under way.
     * @returns {Promise<{ on: boolean, pending: boolean }>}
     */
    async pairPostings() {
        const mode = await this.store.pairsMode();
        return { on: mode === PAIRS.building || mode === PAIRS.on, pending: mode === PAIRS.building || mode === PAIRS.deleting };
    }

    /**
     * Turns pair postings on or off (nothing is written when it already is so), then runs the build or delete.
     * @param {boolean} on
     */
    async setPairPostings(on) {
        if ((await this.pairPostings()).on !== on) await this.store.commit([{ kind: 'searchPairs', on }]);
        this.runPairPostings();
    }

    /**
     * Runs the pair postings' build or delete under way, if any, a slice at a time with `pauseMs` between, until
     * done or the store closes; one run at a time. Called after the server listens (a stop leaves one to resume)
     * and after the option changes.
     * @param {number} [pauseMs]
     * @returns {Promise<void>}
     */
    runPairPostings(pauseMs = 10) {
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
     * Runs `write` after every earlier write to the same entity has settled, so each diffs against what the one
     * before it stored.
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
     * @param {number} type
     * @param {string[]} keys
     * @returns {Promise<(bigint | null)[]>}
     */
    ids(type, keys) {
        return this.store.libraryIds(keys.map(k => [type, k]));
    }

    /**
     * @param {(bigint | null)[]} ids
     * @param {{ fields: (number | string)[], lists: number[] }} [only] Read only these values, and no hashes.
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
     * Stores a character's card, writing only what differs from the stored one; a new avatar is a new character.
     * @param {import('./users.js').UserDirectoryList} directories
     * @param {string} avatar
     * @param {string} cardJson
     * @param {object} [options]
     * @param {string | null} [options.contentHash] sha256 of the uploaded file's bytes (imports).
     * @param {string | null} [options.avatarIdentityHash]
     * @param {number} [options.dateAdded]
     * @param {boolean} [options.fav] The favourite flag for a new character; a stored one keeps its own.
     * @param {{ from: string, pastChats: boolean, at?: number }} [options.renamed] The card is the stored one renamed from `from`. With `pastChats`, past messages show the new name (the rename history is cleared); without, messages sent before `at` (now) keep showing `from`, and any earlier rename's names stay.
     * @param {bigint[]} [options.tags] Tag ids added to what the character carries, in the same commit as the card.
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
            // A `character_book` holding a list of entries is the character's own book; anything else stays JSON.
            const bookAt = parts.extra.findIndex(x => x.path === 'data:character_book');
            const book = bookAt === -1 ? undefined : JSON.parse(/** @type {string} */ (parts.extra[bookAt].value));
            if (isEntryList(book)) parts.extra.splice(bookAt, 1);
            pushAll(records, (await this.books.ownedRecords(id, SLOT.characterBook, isEntryList(book) ? book : undefined)));
            const next = cardValues(parts);
            const kept = stored ? storedValues(stored).lists.get(NAME_HISTORY) ?? [] : [];
            const history = renamed ? renamedHistory(kept, renamed) : kept;
            if (history.length > 0) next.lists.set(NAME_HISTORY, history);
            const world = next.values.get(FIELD.world)?.text;
            const linkKey = world ? bookKey(world) : '';
            if (linkKey && world === linkKey) next.values.delete(FIELD.world);
            records.push(...valueRecords(id, stored, next));
            // Loaded here, not at the top: it reaches the world book reads, which reach the user stores, which load this module.
            const { getCharaCardV2 } = await import('./character-card-normalize.js');
            const normalized = getCharaCardV2(JSON.parse(cardJson), directories, false);
            const size = calculateDataSize(normalized.data ?? {});
            if (stored?.dataSize !== size) records.push({ kind: 'dataSize', entity: id, size });
            const ms = parseCreateDateToEpochMs(normalized.create_date);
            if (!stored || (stored.createMs ?? null) !== ms) records.push({ kind: 'createDate', entity: id, ...(ms === null ? {} : { ms }) });
            const hashes = [[HASH.identity, computeContentIdentityHash(card)], [HASH.content, contentHash], [HASH.avatarIdentity, avatarIdentityHash]];
            for (const [which, hex] of hashes) {
                // A hash is replaced only by a new one: most writers have none, and an import's must outlive them.
                if (hex === null) continue;
                const had = stored?.hashes.find(h => h.which === which);
                if (had && had.hash.toString('hex') === hex) continue;
                records.push({ kind: 'cardHash', entity: id, which, hash: Buffer.from(hex, 'hex') });
            }
            records.push(...this.tags.addRecords(stored ?? { id, tags: [] }, tags));
            // A new entity's create comes after its values, so it enters the orders once, with its keys.
            if (!stored) records.push({ kind: 'entityCreate', entity: id, type: TYPE.character, key: avatar, added: dateAdded });
            const commit = async () => {
                records.push(...(await this.linkRecords(id, stored, linkKey)));
                if (records.length === 0) return;
                if (this.batches > 0) await this.cardCommits.commit(records);
                else await this.store.commit(records);
            };
            // A name no book has becomes an unresolved book, made once whichever card links it first.
            if (linkKey) await this.serialized(TYPE.book, linkKey, commit);
            else await commit();
            return { id, records: records.length };
        });
    }

    /**
     * The records linking character `id` to the book keyed `key` (none: no link), the book made as an unresolved
     * name when there is none. Runs in the key's lane.
     * @param {bigint} id
     * @param {StoredEntity | null} stored
     * @param {string} key
     * @returns {Promise<object[]>}
     */
    async linkRecords(id, stored, key) {
        if (!key) return stored?.link ? [{ kind: 'bookLink', entity: id }] : [];
        // A link already resolving as the book with that key names it, through whatever forwards.
        if (stored?.link?.key === key) return [];
        const records = [];
        let [book] = await this.ids(TYPE.book, [key]);
        if (book === null) {
            book = this.nextId++;
            records.push({ kind: 'entityCreate', entity: book, type: TYPE.book, key, added: Date.now() });
        }
        records.push({ kind: 'bookLink', entity: id, book });
        return records;
    }

    /**
     * Stores a group, writing only what differs from the stored one; its fav is the object's (normalizeFav()).
     * @param {Record<string, unknown> & { id: string }} group
     * @param {object} [options]
     * @param {number} [options.dateAdded] For a new group.
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
     * Changes a stored group: `change` edits its object (its own values, id and fav, as `groups()` answers it but
     * its tag ids) in place, and what then differs is written, after every earlier write to the group.
     * @param {string} key
     * @param {(group: Record<string, any>) => void} change
     * @returns {Promise<boolean>} Whether there is such a group.
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
     * A new character's or group's id: the id of the unowned tree kept under its owner key (its messages become
     * its own; `records` gets that entity's delete first), else a new one.
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
     * Each group as `/api/groups/batch` answers it (its own values, id, fav and tag ids), or null.
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
     * The characters changed after a change feed position, each once at its last change (`/api/characters/changes`'s
     * answer): `seq` the position read up to, `changes` `{ id: avatar, op: 'upsert' | 'delete', fields: null }`.
     * The feed holds one entry per entity, so it is never truncated.
     * @param {number} sinceSeq
     * @param {number} limit Feed entries read (other entities' included).
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
     * Where the characters' change feed (`changes()`) ends now.
     * @returns {Promise<number>}
     */
    async changesEnd() {
        return Number((await this.store.chatRead('entityChanges', { after: 0n, limit: 0 })).end);
    }

    /**
     * The library-wide half of the page's `findChar()` (`/api/characters/find`): the characters it would match if
     * every one were held. An avatar key (with or without `.png`) wins; else the name compares as
     * `compareIgnoreCaseAndAccents()` (`insensitive`) or exactly; with `tags`, a character must carry a tag of each
     * name, compared exactly. At most two avatars in avatar order, the first `findChar()`'s answer, a second meaning
     * more than one matched; `capped` when `FIND_WORK_CAP` entities were read before two matched.
     * @param {{ name?: string | null, allowAvatar?: boolean, insensitive?: boolean, tags?: string[] | null }} q
     * @returns {Promise<{ ids: string[], capped: boolean }>}
     */
    async findCharacters({ name = null, allowAvatar = true, insensitive = true, tags = null }) {
        const hasName = typeof name === 'string' && name !== '';
        const tagNames = Array.isArray(tags) && tags.length > 0 ? tags.map(String) : null;
        /** @type {string[]} The wanted tags' keys, a tag of each name. */
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
     * The groups whose name compares equal to `name` as `compareIgnoreCaseAndAccents()` does, at most two, in id
     * order.
     * @param {string} name
     * @returns {Promise<string[]>}
     */
    async findGroups(name) {
        const key = tagNameKey(String(name));
        const candidates = await this.store.chatRead('libraryNamed', { type: TYPE.group, name: String(name), limit: FIND_WORK_CAP });
        const groups = await this.groups((await this.store.libraryKeys(candidates.map((/** @type {any} */ c) => c.id))).filter(Boolean).map((/** @type {any} */ k) => k.key));
        return groups.filter(g => g && tagNameKey(String(g.name)) === key).map(g => /** @type {any} */ (g).id).sort().slice(0, 2);
    }

    // ---- the local import scan's bookkeeping (localImport.directories) ----

    /**
     * The mtime each source path was last processed at, for the paths that have one.
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
     * Records that a source path was processed at `mtimeMs` (and the character it duplicates, whose delete forgets
     * it); nothing is written when that is what is recorded.
     * @param {string} path
     * @param {number} mtimeMs
     * @param {string | null} [duplicateOf] The character's avatar.
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
     * Up to `limit` paths with a recorded mtime after `after` ('' : from the first), in path order.
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
     * Records a source path that isn't a character, at its mtime; nothing is written when that is recorded.
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
     * The chat stats list rows show of characters and groups (their trees are their ids): the newest message's time
     * and the chat size, 0 for a tree with none.
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
     * @returns {Promise<boolean>} Whether there is such a character.
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
     * Changes an entity's key (a character's avatar) or date added; the type stays.
     * @param {number} type
     * @param {string} key
     * @param {{ key?: string, dateAdded?: number }} change
     * @returns {Promise<boolean>} Whether there is such an entity; false also when the new key is taken.
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
     * The first character a card hash finds (`HASH`), as import dedup looks one up.
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
     * The first character both its content identity hash and its avatar identity hash find.
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
     * @returns {Promise<boolean | null>} Whether it changed; null when there's no such entity.
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
     * Stores a tag's definition, writing only what differs from the stored one; a key only assignments named gets
     * its definition.
     * @param {{ id: string, name?: string, folder_type?: string, [key: string]: unknown }} tag
     * @param {object} [options]
     * @param {(id: bigint) => object[]} [options.extra] Records committed with the definition's, given the tag's id.
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
     * The records writeTag() commits for `tag`, read against what is stored now; a new tag's id is given out here.
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
        // The marker is the last value, so the tag enters its orders once, with its name, folder type and order.
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
     * @returns {Promise<boolean>} Whether both exist.
     */
    async assignTag(type, key, tagKey, assigned) {
        const [entity] = await this.ids(type, [key]);
        const [tag] = await this.ids(TYPE.tag, [tagKey]);
        if (entity === null || tag === null) return false;
        await this.store.commit([{ kind: 'tagAssign', entity, tag, assigned }]);
        return true;
    }

    /**
     * Deletes a tag, its carriers becoming `intoKey`'s (or carrying nothing).
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
     * Deletes an entity. A character's or group's chats stay with `keepChats` (upstream leaves chat files on disk): its
     * tree becomes an unowned one under its owner key, which a character or group made with that key adopts.
     * @param {number} type
     * @param {string} key
     * @param {{ keepChats?: boolean }} [options]
     */
    deleteEntity(type, key, { keepChats = false } = {}) {
        return this.serialized(type, key, async () => {
            const [id] = await this.ids(type, [key]);
            if (id === null) return false;
            // A character's own book goes with it.
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
     * Whether a tree holds a message or a bookmark.
     * @param {bigint} tree
     */
    async holdsChats(tree) {
        const children = await this.store.chatRead('children', { tree, limit: 1 });
        if (children.ids.length > 0) return true;
        return (await this.store.chatRead('treeBookmarks', { tree, limit: 1 })).length > 0;
    }

    /**
     * Each character's card as stored (with its favourite flag), or null.
     * @param {string[]} avatars
     * @returns {Promise<(unknown | null)[]>}
     */
    async cards(avatars) {
        const entities = await this.entities(await this.ids(TYPE.character, avatars));
        return Promise.all(entities.map(e => (e ? this.assembled(e) : null)));
    }

    /**
     * A stored character's card, its own book included.
     * @param {StoredEntity} e
     */
    async assembled(e) {
        const parts = cardParts(e);
        const book = await this.books.owned(e.id, SLOT.characterBook);
        if (book !== undefined) parts.extra.push({ path: 'data:character_book', value: JSON.stringify(book) });
        return assembleCard(parts);
    }

    /**
     * The `cardHash` records keeping characters' content identity hashes current when the name their lorebook
     * link reads as becomes `world` (a book renamed): for each one whose card then hashes differently.
     * @param {bigint[]} ids Characters linking the book.
     * @param {string} world
     * @returns {Promise<object[]>}
     */
    async identityRecords(ids, world) {
        const records = [];
        for (let i = 0; i < ids.length; i += 256) {
            const entities = await this.entities(ids.slice(i, i + 256));
            for (const e of entities) {
                if (!e || e.type !== TYPE.character || !e.link) continue;
                const card = await this.assembled({ ...e, link: { ...e.link, key: world } });
                const hex = computeContentIdentityHash(card);
                if (e.hashes.find(h => h.which === HASH.identity)?.hash.toString('hex') !== hex) {
                    records.push({ kind: 'cardHash', entity: e.id, which: HASH.identity, hash: Buffer.from(hex, 'hex') });
                }
            }
        }
        return records;
    }

    /**
     * Each entity's tag keys, in the order the app sorts tag ids.
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
     * Character list rows (toShallow()'s shape), as the old store's readListRowsSync() gives them.
     * @param {StoredEntity[]} entities Characters, read whole or with `listRowValues()`.
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
     * A /query page as the old store's queryEntities() / queryCharacters() answer it: the same parameters and
     * answer shape, keys for ids.
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
     * @param {string} [params.tieSortField] With `sortField: 'search'`: the list sort the matches only tag names
     *   match (all scoring alike) follow; by name if none.
     * @param {'asc' | 'desc'} [params.tieSortOrder]
     * @param {number} [params.tieSeed]
     * @param {number} [params.offset]
     * @param {number} [params.limit]
     * @param {string} [params.cursor] A page's `cursor`; one made for another sort answers `'invalid-cursor'`.
     * @param {boolean} [params.wantRows]
     * @param {boolean} [params.wantTotal]
     * @param {boolean} [params.wantHashes]
     * @param {boolean} [params.groupsOnly]
     * @param {boolean} [params.includeGroups]
     * @param {boolean} [params.includeCreatorNotes]
     * @param {boolean} [params.wantHidden] Also `hidden` and `approxHidden`, as `/query`'s `want: 'hidden'`.
     * @param {{ characters: boolean, groups: boolean }} [params.hiddenKinds] What `hidden` counts every entity of; by
     *   default the kinds this page may hold.
     * @param {number} [params.cap]
     * @param {string} [params.search] Only the characters and groups the search string matches (`searchClauses()`
     *   with the library's labels); with `sortField: 'search'` best match first.
     */
    async query(params) {
        const { tags, fav, world, ranges, excludeIds, ids, sortField, sortOrder, seed, tieSortField, tieSortOrder, tieSeed, offset = 0, limit = 500, cursor, wantRows = true, wantTotal = true, wantHashes = false, wantHidden = false, groupsOnly = false, includeGroups = true, includeCreatorNotes = false, cap = 20_000, search } = params;
        const hiddenKinds = params.hiddenKinds ?? { characters: !groupsOnly, groups: groupsOnly || includeGroups };
        const clauses = typeof search === 'string' ? searchClauses(search, LIBRARY_LABELS) : [];
        // Every entity of those kinds less the rows on this page.
        const hiddenOf = async (/** @type {number} */ shown) => {
            if (!wantHidden) return {};
            const all = await this.store.libraryPage({ ...hiddenKinds, count: true, limit: 0, cap, sort: { key: SORT_KEYS.name, desc: false } });
            return { hidden: Math.max(0, Number(all.total) - shown), approxHidden: !all.totalExact };
        };
        const include = (tags?.include ?? []).filter(Boolean).map(String);
        const exclude = (tags?.exclude ?? []).filter(Boolean).map(String);
        const tagIds = new Map();
        const tagKeys = [...new Set([...include, ...exclude, ...Object.keys(ranges ?? {}).filter(k => k.startsWith('tag:')).map(k => k.slice(4))])];
        // A deleted tag filters as the live tag its merges lead to; one deleted with no merge as no tag.
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
        // A list cursor names the order it was made in (`e<order>.<place>`); one made in another is refused.
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
                // A cursor whose weights don't fit the query's words.
                if (after && /^invalid cursor/.test(String(/** @type {any} */ (err)?.message))) return 'invalid-cursor';
                throw err;
            }
            const relevanceCursor = relevance && s.more && s.next ? relevanceCursorOf(s.next, order) : undefined;
            page = { ...s, cursor: relevance ? undefined : s.cursor, relevanceCursor, more: relevance ? false : s.more };
        } else {
            page = await this.store.libraryPage(q);
        }
        // A row reads only what the list draws; a group's object is all its own values.
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
        // A group deleted between the two reads is gone, as one deleted before the first.
        const entities = pageEntities.filter(e => e.type !== TYPE.group || groupOf.has(e.id));
        const groupTags = new Map((await this.tagKeys(groups)).map((t, i) => [groups[i].id, t]));
        const stats = await this.chatStats(entities.map(e => e.id));
        const statsOf = (/** @type {bigint} */ id) => stats.get(id) ?? { date_last_chat: 0, chat_size: 0 };
        if (wantHashes) {
            const hashRows = entities.map(e => this.hashRow(groupOf.get(e.id) ?? e, groupTags.get(e.id) ?? [], statsOf(e.id)));
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
     * A hash-mode row: a character's cache key is its version, the position of its latest record; a group's are
     * the digests of what `groups()` answers for it.
     * @param {StoredEntity} e
     * @param {string[]} tagKeys A group's tag keys.
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
            // A renamed or deleted lorebook changes what the card reads as.
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
        }
        return row;
    }
}
