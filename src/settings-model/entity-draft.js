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
 * A part keyed by its natural id under its holder, `<holder>:<id>`. The id isn't kept again among its values, which
 * the key gives back; a missing, malformed or repeated id gets a fallback key by its place (`<holder>:#<index>`), the
 * record kept whole, warned.
 * @param {number} type
 * @param {string} holder The holder's key.
 * @param {Record<string, any>} record
 * @param {object} options
 * @param {string} options.idField
 * @param {number} options.index
 * @param {Set<string>} options.seen The ids taken so far under the holder.
 * @param {string[]} options.warnings
 * @param {string} options.what What the part is, for the warning.
 * @param {(id: unknown) => boolean} [options.valid] Whether an id can be given back from the key.
 * @returns {EntityDraft}
 */
export function keyedPart(type, holder, record, { idField, index, seen, warnings, what, valid = id => typeof id === 'string' && id !== '' }) {
    const id = record?.[idField];
    // An id of the fallback's form would read back as one.
    if (valid(id) && !String(id).startsWith('#') && !seen.has(String(id))) {
        seen.add(String(id));
        return draft(type, `${holder}:${id}`, without(record, [idField]));
    }
    warnings.push(`${holder}: ${what} ${index + 1} has ${valid(id) ? 'a repeated' : 'no usable'} ${idField}; kept under its place`);
    return draft(type, `${holder}:#${index}`, record && typeof record === 'object' ? { ...record } : { value: record });
}

/**
 * A part's record, its id given back from its key unless its values hold it.
 * @param {EntityDraft} part
 * @param {string} holder
 * @param {string} idField
 * @param {(text: string) => unknown} [parse]
 * @returns {Record<string, unknown>}
 */
export function partRecord(part, holder, idField, parse = text => text) {
    if (Object.hasOwn(part.values, idField) || part.key.startsWith(`${holder}:#`)) return { ...part.values };
    return { [idField]: parse(part.key.slice(holder.length + 1)), ...part.values };
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
