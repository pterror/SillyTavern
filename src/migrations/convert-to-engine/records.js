import { splitCard } from '../../character-card-storage.js';
import { getCharaCardV2, computeContentIdentityHash } from '../../character-card-normalize.js';
import { calculateDataSize } from '../../character-shallow.js';
import { parseCreateDateToEpochMs } from '../../util.js';
import { tagDerivedColumns } from '../../tag-order.js';
import { FIELD, TAG_KEY_PREFIX, TYPE } from '../../library-codes.js';
import { HASH, cardValues, groupValues } from '../../library-engine.js';
import { valueRecords } from '../../entity-values.js';
import { WorldInfoEngine, SLOT, isEntryList } from '../../world-info-engine.js';
import { bookKey } from '../../world-info-keys.js';
import { normalizeFav } from '../../../public/scripts/hash-utils.js';

/**
 * The records a new entity of the library is made of, built without reading a store: the same records
 * `LibraryEngine.writeCard()`, `writeGroup()`, `tagRecords()` and `WorldInfoEngine.write()` commit for an entity that
 * isn't stored yet. Ids come from one allocator (`{ nextId }`), so they are given out as the store's writer would.
 */

/**
 * @typedef {{ nextId: bigint }} Ids
 */

/**
 * A character's records, as `writeCard()` writes a new one: its values, fav, sort keys and hashes, then its create.
 * Its own book (a `character_book` holding a list of entries) and its lorebook link are written after the load (an
 * owned book's entries and a link's book are in other partitions).
 * @param {bigint} id
 * @param {string} avatar
 * @param {Record<string, any>} card The card as stored, with its stored fav (`cardWithStoredFav()`).
 * @param {object} p
 * @param {boolean} p.fav
 * @param {number} p.dateAdded
 * @param {string | null} p.contentHash
 * @param {string | null} p.avatarIdentityHash
 * @param {string | null} p.avatarHash
 * @param {import('../../users.js').UserDirectoryList} p.directories
 * @returns {{ records: object[], book: Record<string, unknown> | undefined, linkKey: string, name: string }} `book`:
 * its own book; `linkKey`: the key of the book its lorebook names ('' for none); `name`: its name as the library reads it.
 */
export function characterRecords(id, avatar, card, { fav, dateAdded, contentHash, avatarIdentityHash, avatarHash, directories }) {
    const records = [];
    if (fav) records.push({ kind: 'fav', entity: id, fav: true });
    const parts = splitCard(card);
    const bookAt = parts.extra.findIndex(x => x.path === 'data:character_book');
    const book = bookAt === -1 ? undefined : JSON.parse(/** @type {string} */ (parts.extra[bookAt].value));
    if (isEntryList(book)) parts.extra.splice(bookAt, 1);
    const next = cardValues(parts);
    const nameValue = next.values.get(FIELD.name);
    const name = nameValue === undefined ? '' : nameValue.text !== undefined ? nameValue.text : JSON.parse(/** @type {string} */ (nameValue.json));
    const world = next.values.get(FIELD.world)?.text;
    const linkKey = world ? bookKey(world) : '';
    if (linkKey && world === linkKey) next.values.delete(FIELD.world);
    for (const r of valueRecords(id, null, next)) records.push(r);
    const normalized = quietly(() => getCharaCardV2(JSON.parse(JSON.stringify(card)), directories, false));
    records.push({ kind: 'dataSize', entity: id, size: calculateDataSize(normalized.data ?? {}) });
    const ms = parseCreateDateToEpochMs(normalized.create_date);
    records.push({ kind: 'createDate', entity: id, ...(ms === null ? {} : { ms }) });
    const hashes = [[HASH.identity, computeContentIdentityHash(card)], [HASH.content, contentHash], [HASH.avatarIdentity, avatarIdentityHash], [HASH.avatar, avatarHash]];
    for (const [which, hex] of hashes) {
        if (hex === null || hex === undefined) continue;
        records.push({ kind: 'cardHash', entity: id, which, hash: Buffer.from(/** @type {string} */ (hex), 'hex') });
    }
    records.push({ kind: 'entityCreate', entity: id, type: TYPE.character, key: avatar, added: dateAdded });
    return { records, book: isEntryList(book) ? book : undefined, linkKey, name };
}

/**
 * Runs `fn` with `console.warn` silenced: the card normalizer warns per card about fields a card lacks, which over
 * a whole library is noise (and prints the cards' names).
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function quietly(fn) {
    const warn = console.warn;
    console.warn = () => {};
    try {
        return fn();
    } finally {
        console.warn = warn;
    }
}

/**
 * A group's records, as `writeGroup()` writes a new one.
 * @param {bigint} id
 * @param {Record<string, unknown> & { id: string }} group
 * @param {number} dateAdded
 */
export function groupRecords(id, group, dateAdded) {
    const records = [];
    if (normalizeFav(group.fav)) records.push({ kind: 'fav', entity: id, fav: true });
    for (const r of valueRecords(id, null, groupValues(group))) records.push(r);
    records.push({ kind: 'entityCreate', entity: id, type: TYPE.group, key: String(group.id), added: dateAdded });
    return records;
}

/**
 * A tag definition's records, as `tagRecords()` writes a new one: its values, its order, the definition marker last,
 * then its create.
 * @param {bigint} id
 * @param {{ id: string, [key: string]: unknown }} tag
 * @param {number} added
 */
export function tagRecords(id, tag, added) {
    /** @type {Map<number | string, { text?: string, json?: string }>} */
    const values = new Map();
    for (const [k, v] of Object.entries(tag)) {
        if (k === 'id' || v === undefined) continue;
        const field = k === 'name' ? FIELD.name : k === 'folder_type' ? FIELD.folder_type : `${TAG_KEY_PREFIX}${k}`;
        values.set(field, typeof v === 'string' && typeof field === 'number' ? { text: v } : { json: JSON.stringify(v) });
    }
    values.set(FIELD.defined, { json: '' });
    const records = valueRecords(id, null, { values, lists: new Map() });
    const marker = records.findIndex(r => /** @type {any} */ (r).field === FIELD.defined);
    const order = tagDerivedColumns(tag).sortOrder;
    if (order !== null) records.splice(marker, 0, { kind: 'tagOrder', tag: id, order });
    records.push({ kind: 'entityCreate', entity: id, type: TYPE.tag, key: tag.id, added });
    return records;
}

/**
 * A world-info writer over an id allocator, for books not stored yet (`bookRecords()` reads nothing then).
 * @param {Ids} ids
 */
function bookWriter(ids) {
    return new WorldInfoEngine(/** @type {any} */ (ids));
}

/**
 * A world book's records, as `WorldInfoEngine.write()` writes a new one.
 * @param {Ids} ids
 * @param {bigint} id
 * @param {string} key
 * @param {Record<string, unknown>} data
 * @param {number} added
 */
export async function worldBookRecords(ids, id, key, data, added) {
    const records = await bookWriter(ids).bookRecords(id, null, data, { world: true });
    records.unshift({ kind: 'entityCreate', entity: id, type: TYPE.book, key, added });
    return records;
}

/**
 * A character's own book's records, as `writeCard()` writes a new one.
 * @param {Ids} ids
 * @param {bigint} owner
 * @param {Record<string, unknown>} book The card's `character_book`.
 */
export async function ownedBookRecords(ids, owner, book) {
    return bookWriter(ids).bookRecords(ids.nextId++, null, book, { ownedKey: `${owner}:${SLOT.characterBook}` });
}
