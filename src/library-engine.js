import { CARD_COLUMNS, assembleCard, splitCard } from './character-card-storage.js';
import { cardListValues } from './character-card-reader.js';
import { getCharaCardV2, computeContentIdentityHash } from './character-card-normalize.js';
import { calculateDataSize } from './character-shallow.js';
import { parseCreateDateToEpochMs } from './util.js';
import { tagDerivedColumns } from './tag-order.js';
import { groupDigestContentHash, groupDigestFavHash, groupDigestTagIdsHash, normalizeFav, normalizeTagIds } from '../public/scripts/hash-utils.js';

/**
 * The library on the engine: characters, groups and tags as entities whose values are the engine's records.
 *
 * A card is stored as splitCard() splits it, each part its own value: the known text fields as text values, other
 * known values and every extension key and other path as JSON (a marker as empty JSON), greetings and the card's
 * own tag names as list items. A write records only the values that differ from the stored ones: a changed text as
 * one edit, a list by its changed items. The sort keys the app computes with its own functions (the data size, the
 * create date as a time, the content identity hash) are recorded with the card whenever they change.
 */

export const TYPE = Object.freeze({ character: 0, group: 1, tag: 2 });

/** Field codes; the engine reads NAME, WORLD, FOLDER_TYPE and DEFINED itself. */
export const FIELD = Object.freeze({
    name: 1,
    creator: 2,
    character_version: 3,
    world: 4,
    create_date: 5,
    description: 10,
    personality: 11,
    scenario: 12,
    first_mes: 13,
    mes_example: 14,
    creator_notes: 15,
    system_prompt: 16,
    post_history_instructions: 17,
    nickname: 18,
    creation_date: 19,
    modification_date: 20,
    allow_global_styles: 30,
    folder_type: 40,
    /** A tag's definition marker (empty JSON): without it, the tag is a key only assignments name. */
    defined: 41,
});

/** A tag's keys other than its name and folder type are stored by key. */
const TAG_KEY_PREFIX = 'tag:';

/** List codes. */
export const LIST = Object.freeze({ alternate_greetings: 0, group_only_greetings: 1, tags: 2 });

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

/** A list item's text is the text value of this field. */
export function itemField(list, item) {
    return 1024 + item * 8 + list;
}

/** `cardHash` kinds. */
export const HASH = Object.freeze({ identity: 0, content: 1, avatar: 2, avatarIdentity: 3 });

/** Sort key codes of `Store.libraryPage`. */
const SORT_KEYS = Object.freeze({ name: 0, create_date: 1, date_added: 2, date_last_chat: 3, chat_size: 4, data_size: 5 });

/** Positions of a list's items are this far apart, so an item fits between two without moving others. */
const POSITION_GAP = 2 ** 20;

const EXTENSION_PREFIX = 'ext:';

/**
 * Bytes of `text` in WTF-8 (UTF-8 with lone surrogates encoded as their code points), the unit of a text edit.
 * @param {string} text
 */
export function wtf8Length(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
            n += 4;
            i++;
        } else n += 3;
    }
    return n;
}

/**
 * The one edit turning `before` into `after`: what lies between their common start and end, never splitting a
 * surrogate pair.
 * @param {string} before
 * @param {string} after
 * @returns {{ offset: number, removed: number, text: string }} WTF-8 byte offset and length.
 */
export function textEdit(before, after) {
    const max = Math.min(before.length, after.length);
    let start = 0;
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    if (start > 0 && (before.charCodeAt(start - 1) & 0xfc00) === 0xd800) start--;
    let end = 0;
    while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
    if (end > 0 && (before.charCodeAt(before.length - end) & 0xfc00) === 0xdc00) end--;
    return {
        offset: wtf8Length(before.slice(0, start)),
        removed: wtf8Length(before.slice(start, before.length - end)),
        text: after.slice(start, after.length - end),
    };
}

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
        else if (name) texts.forEach((text, position) => parts.greetings.push({ list: name, position, text }));
    }
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

/**
 * @typedef {object} StoredEntity What `Store.libraryEntities` answers.
 * @property {bigint} id
 * @property {number} type
 * @property {string} key
 * @property {number} added
 * @property {bigint} version
 * @property {boolean} fav
 * @property {bigint[]} tags
 * @property {{ field: number | string, text?: string, json?: string }[]} values
 * @property {{ list: number, item: number, position: number }[]} items
 * @property {number} [dataSize]
 * @property {number} [createMs]
 * @property {{ which: number, hash: Buffer }[]} hashes
 * @property {number | null} [tagOrder] A tag's manual sort order as recorded; absent when none was.
 */

/**
 * The entity's field values and its lists (each item's text in order), with each list's item ids and positions.
 * @param {StoredEntity} entity
 */
function storedValues(entity) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    /** @type {Map<number, string>} */
    const itemTexts = new Map();
    for (const v of entity.values) {
        if (typeof v.field === 'number' && v.field >= 1024) itemTexts.set(v.field, /** @type {string} */ (v.text));
        else values.set(v.field, v.text !== undefined ? { text: v.text } : { json: v.json });
    }
    /** @type {Map<number, string[]>} */
    const lists = new Map();
    /** @type {Map<number, { item: number, position: number }[]>} */
    const places = new Map();
    for (const { list, item, position } of entity.items) {
        if (!lists.has(list)) {
            lists.set(list, []);
            places.set(list, []);
        }
        lists.get(list)?.push(itemTexts.get(itemField(list, item)) ?? '');
        places.get(list)?.push({ item, position });
    }
    return { values, lists, places };
}

/**
 * The records turning a stored entity's values (none for a new one) into `values` and `lists`.
 * @param {bigint} entity
 * @param {StoredEntity | null} stored
 * @param {{ values: Map<number | string, { text?: string, json?: string }>, lists: Map<number, string[]> }} next
 * @returns {object[]}
 */
export function valueRecords(entity, stored, next) {
    const old = stored ? storedValues(stored) : { values: new Map(), lists: new Map(), places: new Map() };
    const records = [];
    for (const field of old.values.keys()) {
        if (!next.values.has(field)) records.push({ kind: 'valueDelete', entity, field });
    }
    for (const [field, after] of next.values) {
        const before = old.values.get(field);
        if (after.text !== undefined) {
            if (before?.text === after.text) continue;
            if (before?.text !== undefined) records.push({ kind: 'textEdit', entity, field, ...textEdit(before.text, after.text) });
            else records.push({ kind: 'textValue', entity, field, text: after.text });
        } else if (before?.json !== after.json) {
            records.push({ kind: 'jsonValue', entity, field, json: after.json });
        }
    }
    const counter = { next: 1 + Math.max(0, ...(stored?.items ?? []).map(i => i.item)) };
    for (const list of new Set([...old.lists.keys(), ...next.lists.keys()])) {
        records.push(...listRecords(entity, list, old.lists.get(list) ?? [], old.places.get(list) ?? [], next.lists.get(list) ?? [], counter));
    }
    return records;
}

/**
 * The records turning a list's items `before` (at `places`) into `after`. Items equal at both ends stay; between
 * them, items are edited in place, then the rest added between their neighbours or deleted. When no position is
 * free between the neighbours, every item of the list is placed again, POSITION_GAP apart, above every position
 * it held, so no place lands on one still taken.
 * @param {bigint} entity
 * @param {number} list
 * @param {string[]} before
 * @param {{ item: number, position: number }[]} places
 * @param {string[]} after
 * @param {{ next: number }} counter The next unused item id.
 * @returns {object[]}
 */
function listRecords(entity, list, before, places, after, counter) {
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const oldMid = before.length - head - tail;
    const newMid = after.length - head - tail;
    const paired = Math.min(oldMid, newMid);
    const added = newMid - paired;
    const lo = head + paired > 0 ? places[head + paired - 1].position : -1;
    const hi = head + oldMid < places.length ? places[head + oldMid].position : lo + POSITION_GAP * (added + 1);
    const step = Math.floor((hi - lo) / (added + 1));
    const records = [];
    if (added > 0 && step < 1) {
        const top = places.reduce((m, p) => Math.max(m, p.position), 0);
        for (let i = 0; i < after.length; i++) {
            const position = top + POSITION_GAP * (i + 1);
            if (i < places.length) {
                records.push({ kind: 'itemPlace', entity, list, item: places[i].item, position });
                if (before[i] !== after[i]) records.push({ kind: 'textEdit', entity, field: itemField(list, places[i].item), ...textEdit(before[i], after[i]) });
            } else {
                const item = counter.next++;
                records.push({ kind: 'itemPlace', entity, list, item, position });
                records.push({ kind: 'textValue', entity, field: itemField(list, item), text: after[i] });
            }
        }
        for (let i = after.length; i < places.length; i++) records.push({ kind: 'itemDelete', entity, list, item: places[i].item });
        return records;
    }
    for (let i = 0; i < paired; i++) {
        records.push({ kind: 'textEdit', entity, field: itemField(list, places[head + i].item), ...textEdit(before[head + i], after[head + i]) });
    }
    for (let i = paired; i < oldMid; i++) records.push({ kind: 'itemDelete', entity, list, item: places[head + i].item });
    for (let i = 0; i < added; i++) {
        const item = counter.next++;
        records.push({ kind: 'itemPlace', entity, list, item, position: lo + step * (i + 1) });
        records.push({ kind: 'textValue', entity, field: itemField(list, item), text: after[head + paired + i] });
    }
    return records;
}

/**
 * The library of one user's store.
 */
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
    }

    /**
     * @param {any} engine The engine binding.
     * @param {string} dir
     */
    static async open(engine, dir) {
        const store = await engine.Store.open(dir);
        return new LibraryEngine(store, await store.libraryNextId());
    }

    close() {
        return this.store.close();
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
     * @returns {Promise<(StoredEntity | null)[]>}
     */
    async entities(ids) {
        const present = ids.filter(id => id !== null);
        const found = present.length > 0 ? await this.store.libraryEntities(present) : [];
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
     * @param {string | null} [options.avatarHash] sha256 of the image file.
     * @param {number} [options.dateAdded]
     * @param {boolean} [options.fav] The favourite flag for a new character; a stored one keeps its own.
     * @returns {Promise<{ id: bigint, records: number }>}
     */
    writeCard(directories, avatar, cardJson, { contentHash = null, avatarIdentityHash = null, avatarHash = null, dateAdded = Date.now(), fav } = {}) {
        return this.serialized(TYPE.character, avatar, async () => {
            const card = JSON.parse(cardJson);
            const stored = await this.entity(TYPE.character, avatar);
            const id = stored ? stored.id : this.nextId++;
            const records = [];
            if (!stored) {
                const seeded = fav ?? !!(card?.fav ?? card?.data?.extensions?.fav);
                if (seeded) records.push({ kind: 'fav', entity: id, fav: true });
            }
            records.push(...valueRecords(id, stored, cardValues(splitCard(card))));
            const normalized = getCharaCardV2(JSON.parse(cardJson), directories, false);
            const size = calculateDataSize(normalized.data ?? {});
            if (stored?.dataSize !== size) records.push({ kind: 'dataSize', entity: id, size });
            const ms = parseCreateDateToEpochMs(normalized.create_date);
            if (!stored || (stored.createMs ?? null) !== ms) records.push({ kind: 'createDate', entity: id, ...(ms === null ? {} : { ms }) });
            const hashes = [[HASH.identity, computeContentIdentityHash(card)], [HASH.content, contentHash], [HASH.avatarIdentity, avatarIdentityHash], [HASH.avatar, avatarHash]];
            for (const [which, hex] of hashes) {
                // A hash is replaced only by a new one: most writers have none, and an import's must outlive them.
                if (hex === null) continue;
                const had = stored?.hashes.find(h => h.which === which);
                if (had && had.hash.toString('hex') === hex) continue;
                records.push({ kind: 'cardHash', entity: id, which, hash: Buffer.from(hex, 'hex') });
            }
            // A new entity's create comes after its values, so it enters the orders once, with its keys.
            if (!stored) records.push({ kind: 'entityCreate', entity: id, type: TYPE.character, key: avatar, added: dateAdded });
            if (records.length > 0) await this.store.commit(records);
            return { id, records: records.length };
        });
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
            const id = stored ? stored.id : this.nextId++;
            const records = [];
            const fav = normalizeFav(group.fav);
            if (stored ? stored.fav !== fav : fav) records.push({ kind: 'fav', entity: id, fav });
            records.push(...valueRecords(id, stored, groupValues(group)));
            if (!stored) records.push({ kind: 'entityCreate', entity: id, type: TYPE.group, key, added: dateAdded });
            if (records.length > 0) await this.store.commit(records);
            return { id, records: records.length };
        });
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
     * @returns {Promise<bigint>}
     */
    writeTag(tag) {
        return this.serialized(TYPE.tag, tag.id, async () => {
            const stored = await this.entity(TYPE.tag, tag.id);
            const id = stored ? stored.id : this.nextId++;
            const records = [];
            /** @type {Map<number | string, { text?: string, json?: string }>} */
            const values = new Map();
            for (const [k, v] of Object.entries(tag)) {
                if (k === 'id' || v === undefined) continue;
                const field = k === 'name' ? FIELD.name : k === 'folder_type' ? FIELD.folder_type : `${TAG_KEY_PREFIX}${k}`;
                values.set(field, typeof v === 'string' && typeof field === 'number' ? { text: v } : { json: JSON.stringify(v) });
            }
            // The marker is the last value, so the tag enters its orders once, with its name, folder type and order.
            values.set(FIELD.defined, { json: '' });
            const valueChanges = valueRecords(id, stored, { values, lists: new Map() });
            const marker = valueChanges.findIndex(r => r.field === FIELD.defined);
            const order = tagDerivedColumns(tag).sortOrder;
            if ((stored?.tagOrder ?? null) !== order) {
                valueChanges.splice(marker === -1 ? valueChanges.length : marker, 0, { kind: 'tagOrder', tag: id, ...(order === null ? {} : { order }) });
            }
            records.push(...valueChanges);
            if (!stored) records.push({ kind: 'entityCreate', entity: id, type: TYPE.tag, key: tag.id, added: Date.now() });
            if (records.length > 0) await this.store.commit(records);
            return id;
        });
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
     * @param {number} type
     * @param {string} key
     */
    deleteEntity(type, key) {
        return this.serialized(type, key, async () => {
            const [id] = await this.ids(type, [key]);
            if (id === null) return false;
            await this.store.commit([{ kind: 'entityDelete', entity: id }]);
            return true;
        });
    }

    /**
     * Each character's card as stored (with its favourite flag), or null.
     * @param {string[]} avatars
     * @returns {Promise<(unknown | null)[]>}
     */
    async cards(avatars) {
        const entities = await this.entities(await this.ids(TYPE.character, avatars));
        return entities.map(e => (e ? assembleCard(cardParts(e)) : null));
    }

    /**
     * Each entity's tag keys, in the order the app sorts tag ids.
     * @param {StoredEntity[]} entities
     * @returns {Promise<string[][]>}
     */
    async tagKeys(entities) {
        const tagIds = [...new Set(entities.flatMap(e => e.tags))];
        const tags = await this.entities(tagIds);
        const keyOf = new Map(tagIds.map((t, i) => [t, tags[i]?.key]));
        return entities.map(e => normalizeTagIds(e.tags.map(t => keyOf.get(t)).filter(k => k !== undefined)));
    }

    /**
     * Character list rows (toShallow()'s shape), as the old store's readListRowsSync() gives them.
     * @param {StoredEntity[]} entities Characters.
     * @param {boolean} includeCreatorNotes
     */
    async listRows(entities, includeCreatorNotes) {
        const tagKeys = await this.tagKeys(entities);
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
            row.date_last_chat = 0;
            row.chat_size = 0;
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
     * @param {number} [params.offset]
     * @param {number} [params.limit]
     * @param {string} [params.cursor]
     * @param {boolean} [params.wantRows]
     * @param {boolean} [params.wantTotal]
     * @param {boolean} [params.wantHashes]
     * @param {boolean} [params.groupsOnly]
     * @param {boolean} [params.includeGroups]
     * @param {boolean} [params.includeCreatorNotes]
     * @param {boolean} [params.wantHidden] Also `hidden` and `approxHidden`, as `/query`'s `want: 'hidden'`.
     * @param {number} [params.cap]
     */
    async query(params) {
        const { tags, fav, world, ranges, excludeIds, ids, sortField, sortOrder, seed, offset = 0, limit = 500, cursor, wantRows = true, wantTotal = true, wantHashes = false, wantHidden = false, groupsOnly = false, includeGroups = true, includeCreatorNotes = false, cap = 20_000 } = params;
        // Upstream's "N hidden": every entity of the kinds listed (every character, and every group with groups)
        // less the rows on this page.
        const hiddenOf = async (/** @type {number} */ shown) => {
            if (!wantHidden) return {};
            const all = await this.store.libraryPage({ characters: !groupsOnly, groups: groupsOnly || includeGroups, count: true, limit: 0, cap, sort: { key: SORT_KEYS.name, desc: false } });
            return { hidden: Math.max(0, Number(all.total) - shown), approxHidden: !all.totalExact };
        };
        const include = (tags?.include ?? []).filter(Boolean).map(String);
        const exclude = (tags?.exclude ?? []).filter(Boolean).map(String);
        const tagIds = new Map();
        const tagKeys = [...new Set([...include, ...exclude, ...Object.keys(ranges ?? {}).filter(k => k.startsWith('tag:')).map(k => k.slice(4))])];
        (await this.ids(TYPE.tag, tagKeys)).forEach((t, i) => tagIds.set(tagKeys[i], t));
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
        if (typeof world === 'string' && world) q.world = world;
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
        const desc = sortOrder === 'desc';
        if (sortField === 'random') q.sort = { seed: Number(seed) || 0, desc };
        else if (sortField === 'fav') q.sort = { fav: true, desc };
        else if (Object.hasOwn(SORT_KEYS, sortField ?? '')) q.sort = { key: SORT_KEYS[/** @type {keyof typeof SORT_KEYS} */ (sortField)], desc };
        else q.sort = { key: SORT_KEYS.name, desc: false };
        if (typeof cursor === 'string' && cursor.startsWith('e')) q.cursor = Buffer.from(cursor.slice(1), 'base64url');
        const page = await this.store.libraryPage(q);
        const entities = /** @type {StoredEntity[]} */ ((await this.entities(page.ids)).filter(e => e !== null));
        const out = {
            total: wantTotal ? page.total : undefined,
            approxTotal: wantTotal ? !page.totalExact : false,
            ...(page.cursor ? { cursor: `e${page.cursor.toString('base64url')}` } : {}),
            ...(page.more ? { more: true } : {}),
        };
        const groups = entities.filter(e => e.type === TYPE.group);
        const groupTags = new Map((await this.tagKeys(groups)).map((t, i) => [groups[i].id, t]));
        if (wantHashes) {
            const hashRows = entities.map(e => this.hashRow(e, groupTags.get(e.id) ?? []));
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
            date_last_chat: 0,
            chat_size: 0,
            item: e.type === TYPE.group
                ? { ...groupObject(e), fav: e.fav, date_added: e.added, date_last_chat: 0, chat_size: 0, tag_ids: groupTags.get(e.id) ?? [] }
                : listRows.get(e.id) ?? null,
        }));
        return { ...out, hashRows: undefined, rows, ...(await hiddenOf(rows.length)) };
    }

    /**
     * A hash-mode row: a character's cache key is its version, the position of its latest record; a group's are
     * the digests of what `groups()` answers for it.
     * @param {StoredEntity} e
     * @param {string[]} tagKeys A group's tag keys.
     */
    hashRow(e, tagKeys) {
        const row = {
            id: e.key,
            isGroup: e.type === TYPE.group,
            chat: null,
            date_added: e.added,
            create_date: e.type === TYPE.group ? e.added : (e.createMs ?? null),
            date_last_chat: 0,
            chat_size: 0,
            data_size: e.dataSize ?? 0,
            version: e.type === TYPE.group ? null : Number(e.version),
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
