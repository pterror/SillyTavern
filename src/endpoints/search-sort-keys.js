import { NAME_ORDER_LIMIT } from '../character-metadata-db.js';

// Fast fields for native tantivy sorting (orderByField), avoiding a full-match-set SQLite round trip.
export const TANTIVY_FAST_FIELDS = ['create_date', 'date_added', 'date_last_chat', 'chat_size', 'data_size'];

/**
 * Every sort reads one of these fields in descending order, since the binding reports an ascending sort's order
 * rounded (`u64::MAX - value` in a JS number). An ascending order is a field holding SORT_KEY_TOP − value. The name
 * and fav fields hold the stored name order's positions (character-metadata-db.js `name_order`), the fav bit above
 * them at NAME_ORDER_LIMIT. Every value stays below 2^53, so a JS number holds it exactly.
 */
export const SORT_KEY_TOP = 2 ** 53 - 1;
export const TANTIVY_ASC_FIELDS = TANTIVY_FAST_FIELDS.map(field => `${field}_asc`);
export const TANTIVY_NAME_FIELDS = ['name_asc', 'name_desc', 'fav_first', 'fav_last'];

/**
 * The sort keys of one entity, as the characters index stores them and the groups' merge compares them.
 * @param {{ create_date: number, date_added: number, date_last_chat: number, chat_size: number, data_size: number }} values
 * @param {boolean} fav
 * @param {{ asc: number, desc: number } | undefined} positions Its name order positions; 0 when not placed yet.
 */
export function sortKeysOf(values, fav, positions) {
    const asc = positions?.asc ?? 0;
    const desc = positions?.desc ?? 0;
    /** @type {Record<string, number>} */
    const keys = {};
    for (const field of TANTIVY_FAST_FIELDS) {
        keys[field] = values[field];
        keys[`${field}_asc`] = SORT_KEY_TOP - values[field];
    }
    keys.name_asc = SORT_KEY_TOP - asc;
    keys.name_desc = SORT_KEY_TOP - desc;
    // fav desc: favourites first; fav asc: the others first. Names go A to Z inside each in both.
    keys.fav_first = SORT_KEY_TOP - ((fav ? 0 : 1) * NAME_ORDER_LIMIT + asc);
    keys.fav_last = SORT_KEY_TOP - ((fav ? 1 : 0) * NAME_ORDER_LIMIT + asc);
    return keys;
}

/**
 * The index field a sort reads, always in descending order.
 * @param {string} sortField
 * @param {string} sortOrder
 * @returns {string | null} null when the index has no field for the sort.
 */
export function sortKeyField(sortField, sortOrder) {
    const asc = sortOrder === 'asc';
    if (sortField === 'name') return asc ? 'name_asc' : 'name_desc';
    if (sortField === 'fav') return asc ? 'fav_last' : 'fav_first';
    if (TANTIVY_FAST_FIELDS.includes(sortField)) return asc ? `${sortField}_asc` : sortField;
    return null;
}
