/**
 * An entity of the settings model as its modules make it from upstream's files and give it back (the settings model
 * §1): its type and key, its values by field name, and its ordered lists, each item a text or an entity of its own
 * (a part). The store writes and reads these; the modules convert them, and nothing else.
 */

/**
 * @typedef {object} EntityDraft
 * @property {number} type One of library-codes.js's TYPE.
 * @property {string} key
 * @property {Record<string, unknown>} values A value per field name; an object or array that isn't modeled is kept as
 *   it came (JSON).
 * @property {Record<number, (string | EntityDraft)[]>} [lists] Ordered lists by number.
 */

/**
 * A part of an entity: an entity of its own, keyed under its holder.
 * @param {number} type
 * @param {string} key
 * @param {Record<string, unknown>} values
 * @param {Record<number, (string | EntityDraft)[]>} [lists]
 * @returns {EntityDraft}
 */
export function draft(type, key, values, lists) {
    return { type, key, values, ...(lists && Object.keys(lists).length ? { lists } : {}) };
}

/**
 * The values of an object, less some keys.
 * @param {Record<string, unknown>} object
 * @param {Iterable<string>} keys
 * @returns {Record<string, unknown>}
 */
export function without(object, keys) {
    const leave = new Set(keys);
    return Object.fromEntries(Object.entries(object).filter(([key]) => !leave.has(key)));
}

/**
 * The values of an object, only some keys, those it has.
 * @param {Record<string, unknown>} object
 * @param {Iterable<string>} keys
 * @returns {Record<string, unknown>}
 */
export function only(object, keys) {
    return Object.fromEntries([...keys].filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}
