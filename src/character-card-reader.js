import { assembleCard, cardNameSource } from './character-card-storage.js';
import { resolveTagIds } from './tag-deletions.js';
import { normalizeTagIds } from '../public/scripts/hash-utils.js';

/**
 * Reads characters stored as fields (storage redesign, step 5): the card tables below plus the `characters` row,
 * split by character-card-storage.js. character-metadata-db.js reads cards and list rows through this when its store
 * is in that layout.
 *
 * In that layout the `characters` columns `name`, `creator`, `character_version`, `world` and `create_date_raw` hold
 * the card's own values raw (NULL when the card has none, or has a value of another type, which is in `card_extra`),
 * `fav` the favourite flag, and the rest the row's own values.
 */

/** The card tables. Each row is one value of one character's card; see splitCard() for what goes where. */
export const CARD_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS card_fields (
        character_id TEXT NOT NULL,
        field        TEXT NOT NULL,
        value        TEXT NOT NULL,
        PRIMARY KEY (character_id, field)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS card_greetings (
        character_id TEXT NOT NULL,
        list         TEXT NOT NULL,
        position     INTEGER NOT NULL,
        text         TEXT NOT NULL,
        PRIMARY KEY (character_id, list, position)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS card_tags (
        character_id TEXT NOT NULL,
        position     INTEGER NOT NULL,
        name         TEXT NOT NULL,
        PRIMARY KEY (character_id, position)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS card_extensions (
        character_id TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        TEXT NOT NULL,
        PRIMARY KEY (character_id, key)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS card_extra (
        character_id TEXT NOT NULL,
        path         TEXT NOT NULL,
        value        TEXT,
        PRIMARY KEY (character_id, path)
    ) WITHOUT ROWID;
`;

/** The meta key whose value 'fields' marks a store whose characters are in the fields layout; any other is 'blob'. */
export const CARD_LAYOUT_META_KEY = 'card_layout';

/**
 * The layout a store's characters are in, by its meta row (a store without `card_json` is not enough: stores from
 * before that column existed lack it too).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {'blob' | 'fields'}
 */
export function cardLayoutOf(db) {
    if (!db.get('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = \'meta\'')) return 'blob';
    const row = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = ?', [CARD_LAYOUT_META_KEY]));
    return row?.value === 'fields' ? 'fields' : 'blob';
}

/**
 * @param {string[]} ids
 * @returns {string}
 */
function idsJson(ids) {
    return JSON.stringify(ids);
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} sql Selects `character_id` first; `?` is bound to the ids' JSON array.
 * @param {string[]} ids
 * @param {unknown[]} [moreArgs]
 * @returns {Map<string, any[]>}
 */
function rowsById(db, sql, ids, moreArgs = []) {
    /** @type {Map<string, any[]>} */
    const out = new Map();
    for (const row of /** @type {Iterable<{ character_id: string }>} */ (db.iterate(sql, [idsJson(ids), ...moreArgs]))) {
        const list = out.get(row.character_id);
        if (list) list.push(row);
        else out.set(row.character_id, [row]);
    }
    return out;
}

/**
 * The `characters` columns of a card, as splitCard() names them, from a row of the fields layout.
 * @param {{ name: unknown, creator: unknown, character_version: unknown, world: unknown, create_date_raw: unknown, fav: unknown }} row
 * @returns {import('./character-card-storage.js').CardParts['columns']}
 */
function columnsOfRow(row) {
    /** @type {Record<string, unknown>} */
    const columns = { fav: !!row.fav };
    for (const key of ['name', 'creator', 'character_version', 'world']) {
        const value = row[/** @type {'name'} */ (key)];
        if (value !== null && value !== undefined) columns[key] = value;
    }
    if (row.create_date_raw !== null && row.create_date_raw !== undefined) columns.create_date = row.create_date_raw;
    return /** @type {import('./character-card-storage.js').CardParts['columns']} */ (columns);
}

/**
 * Each character's whole card, assembled from the fields layout. Ids without a row are absent.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string[]} ids A bounded list (one request's, one batch's).
 * @returns {Map<string, unknown>}
 */
export function assembleCardsSync(db, ids) {
    /** @type {Map<string, unknown>} */
    const cards = new Map();
    if (ids.length === 0) return cards;
    const inIds = 'IN (SELECT value FROM json_each(?))';
    const fields = rowsById(db, `SELECT character_id, field, value FROM card_fields WHERE character_id ${inIds}`, ids);
    const greetings = rowsById(db, `SELECT character_id, list, position, text FROM card_greetings WHERE character_id ${inIds}`, ids);
    const tags = rowsById(db, `SELECT character_id, position, name FROM card_tags WHERE character_id ${inIds}`, ids);
    const extensions = rowsById(db, `SELECT character_id, key, value FROM card_extensions WHERE character_id ${inIds}`, ids);
    const extra = rowsById(db, `SELECT character_id, path, value FROM card_extra WHERE character_id ${inIds}`, ids);
    for (const row of /** @type {Iterable<any>} */ (db.iterate(`SELECT id, name, creator, character_version, world, create_date_raw, fav FROM characters WHERE id ${inIds}`, [idsJson(ids)]))) {
        const id = row.id;
        cards.set(id, assembleCard({
            columns: columnsOfRow(row),
            fields: fields.get(id) ?? [],
            greetings: greetings.get(id) ?? [],
            tags: tags.get(id) ?? [],
            extensions: extensions.get(id) ?? [],
            extra: extra.get(id) ?? [],
        }));
    }
    return cards;
}

/**
 * The name the blob layout's `name` column holds for `card`: getCharaCardV2(card).name, '' for none, a number as
 * its text (the column's TEXT affinity).
 * @param {unknown} card
 * @returns {string}
 */
export function cardNameText(card) {
    if (typeof card !== 'object' || card === null || Array.isArray(card)) return '';
    const record = /** @type {Record<string, any>} */ (card);
    const name = cardNameSource(record) === 'data' ? record.data.name : record.name;
    if (typeof name === 'string') return name;
    if (typeof name === 'number') return String(name);
    return '';
}

/**
 * @param {unknown} value
 * @param {unknown} fallback
 */
function orDefault(value, fallback) {
    return value === undefined ? fallback : value;
}

/**
 * The card values a list row shows, as the blob layout's shallow copy holds them: toShallow() of
 * getCharaCardV2(card), with V1 keys hoisted from `data` for a card with `spec`, and a card without `spec` read from
 * its V1 keys alone (convertToV2(): comma-split string tags, defaults for the rest).
 * @param {unknown} card
 * @param {boolean} includeCreatorNotes `performance.shallowCharactersIncludeCreatorNotes`
 * @returns {{ name: unknown, tags: unknown, create_date: unknown, data: { name: unknown, character_version: unknown, creator: unknown, tags: unknown, creator_notes?: unknown, world: unknown } }}
 */
export function cardListValues(card, includeCreatorNotes) {
    const record = /** @type {Record<string, any>} */ (typeof card === 'object' && card !== null && !Array.isArray(card) ? card : {});
    if (record.spec === undefined) {
        const tags = typeof record.tags === 'string' ? record.tags.split(',').map(x => x.trim()).filter(x => x) : record.tags || [];
        return {
            name: record.name,
            tags,
            create_date: record.create_date,
            data: {
                name: orDefault(record.name, ''),
                character_version: '',
                creator: record.creator || '',
                tags,
                ...(includeCreatorNotes && { creator_notes: record.creatorcomment || '' }),
                world: '',
            },
        };
    }
    const data = record.data;
    const hoisted = (/** @type {string} */ key) => (data === undefined || data?.[key] === undefined ? record[key] : data[key]);
    return {
        name: hoisted('name'),
        tags: hoisted('tags'),
        create_date: record.create_date,
        data: {
            name: orDefault(data?.name, ''),
            character_version: orDefault(data?.character_version, ''),
            creator: orDefault(data?.creator, ''),
            tags: orDefault(data?.tags, []),
            ...(includeCreatorNotes && { creator_notes: orDefault(data?.creator_notes, '') }),
            world: orDefault(data?.extensions?.world, ''),
        },
    };
}

/** The card_extra paths cardListValues() can read (the rest of the card it reads is in columns and card_tags). */
const LIST_EXTRA_PATHS = Object.freeze(['whole', 'top:spec', 'present:data', 'top:data', 'name:data', 'name:top', 'data:name', 'top:name',
    'mirror:name', 'data:tags', 'top:tags', 'mirror:tags', 'top:create_date', 'data:creator', 'data:character_version', 'top:creator',
    'present:extensions', 'data:extensions']);
const LIST_CREATOR_NOTES_PATHS = Object.freeze(['data:creator_notes', 'top:creatorcomment', 'mirror:creatorcomment']);
/** The card_fields rows cardListValues() can read: `data` keys it reads that can hold a string. */
const LIST_FIELDS = Object.freeze(['tags', 'extensions']);

/**
 * List rows from the fields layout, in the blob layout's shallow-copy shape (toShallow() as character-metadata-db.js
 * keeps it): the card values from the columns, the card's tag rows and the few card_fields, card_extensions and
 * card_extra rows they can be in, by primary key; fav, chat, tag ids, dates and sizes from the row and character_tags. Ids without a row are absent.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string[]} ids A bounded list (one page's).
 * @param {import('./tag-deletions.js').TagDeletions} deletions
 * @param {boolean} includeCreatorNotes `performance.shallowCharactersIncludeCreatorNotes`
 * @returns {Map<string, Record<string, unknown>>}
 */
export function listRowsFromFieldsSync(db, ids, deletions, includeCreatorNotes) {
    /** @type {Map<string, Record<string, unknown>>} */
    const out = new Map();
    if (ids.length === 0) return out;
    const inIds = 'IN (SELECT value FROM json_each(?))';
    const paths = includeCreatorNotes ? [...LIST_EXTRA_PATHS, ...LIST_CREATOR_NOTES_PATHS] : LIST_EXTRA_PATHS;
    const tags = rowsById(db, `SELECT character_id, position, name FROM card_tags WHERE character_id ${inIds}`, ids);
    const extra = rowsById(db, `SELECT character_id, path, value FROM card_extra WHERE character_id ${inIds} AND path IN (SELECT value FROM json_each(?))`, ids, [JSON.stringify(paths)]);
    const world = rowsById(db, `SELECT character_id, key, value FROM card_extensions WHERE character_id ${inIds} AND key = 'world'`, ids);
    const fieldNames = includeCreatorNotes ? [...LIST_FIELDS, 'creator_notes'] : LIST_FIELDS;
    const fields = rowsById(db, `SELECT character_id, field, value FROM card_fields WHERE character_id ${inIds} AND field IN (SELECT value FROM json_each(?))`, ids, [JSON.stringify(fieldNames)]);
    const tagIds = rowsById(db, `SELECT character_id, tag_id FROM character_tags WHERE character_id ${inIds}`, ids);
    for (const row of /** @type {Iterable<any>} */ (db.iterate(
        `SELECT id, name, creator, character_version, world, create_date_raw, fav, date_added, date_last_chat, chat_size, data_size, active_chat, allow_global_styles FROM characters WHERE id ${inIds}`,
        [idsJson(ids)]))) {
        const id = row.id;
        const card = assembleCard({
            columns: columnsOfRow(row),
            fields: fields.get(id) ?? [],
            greetings: [],
            tags: tags.get(id) ?? [],
            extensions: world.get(id) ?? [],
            extra: extra.get(id) ?? [],
        });
        const values = cardListValues(card, includeCreatorNotes);
        const fav = !!row.fav;
        /** @type {Record<string, unknown>} */
        const shallow = { shallow: true };
        if (values.name !== undefined) shallow.name = values.name;
        shallow.avatar = id;
        if (row.active_chat !== null) shallow.chat = row.active_chat;
        shallow.fav = fav;
        shallow.date_added = row.date_added;
        if (values.create_date !== undefined) shallow.create_date = values.create_date;
        shallow.date_last_chat = row.date_last_chat;
        shallow.chat_size = row.chat_size;
        shallow.data_size = row.data_size;
        if (values.tags !== undefined) shallow.tags = values.tags;
        shallow.tag_ids = resolveTagIds(normalizeTagIds((tagIds.get(id) ?? []).map(r => r.tag_id)), deletions);
        const { world: worldValue, ...dataValues } = values.data;
        shallow.data = { ...dataValues, extensions: { fav, world: worldValue } };
        if (row.allow_global_styles !== null) shallow.allow_global_styles = !!row.allow_global_styles;
        out.set(id, shallow);
    }
    return out;
}
