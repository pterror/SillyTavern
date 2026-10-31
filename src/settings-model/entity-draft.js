/**
 * @typedef {object} EntityDraft
 * @property {number} type
 * @property {string} key
 * @property {Record<string, unknown>} values
 * @property {Record<number, (string | EntityDraft)[]>} [lists]
 */

/**
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
 * @param {number} type
 * @param {string} holder
 * @param {Record<string, any>} record
 * @param {object} options
 * @param {string} options.idField
 * @param {number} options.index
 * @param {Set<string>} options.seen
 * @param {string[]} options.warnings
 * @param {string} options.what
 * @param {(id: unknown) => boolean} [options.valid]
 * @returns {EntityDraft}
 */
export function keyedPart(type, holder, record, { idField, index, seen, warnings, what, valid = id => typeof id === 'string' && id !== '' }) {
    const id = record?.[idField];
    if (valid(id) && !String(id).startsWith('#') && !seen.has(String(id))) {
        seen.add(String(id));
        return draft(type, `${holder}:${id}`, without(record, [idField]));
    }
    warnings.push(`${holder}: ${what} ${index + 1} has ${valid(id) ? 'a repeated' : 'no usable'} ${idField}; kept under its place`);
    return draft(type, `${holder}:#${index}`, record && typeof record === 'object' ? { ...record } : { value: record });
}

/**
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
 * @param {Record<string, unknown>} object
 * @param {Iterable<string>} keys
 * @returns {Record<string, unknown>}
 */
export function without(object, keys) {
    const leave = new Set(keys);
    return Object.fromEntries(Object.entries(object).filter(([key]) => !leave.has(key)));
}

/**
 * @param {Record<string, unknown>} object
 * @param {Iterable<string>} keys
 * @returns {Record<string, unknown>}
 */
export function only(object, keys) {
    return Object.fromEntries([...keys].filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}
