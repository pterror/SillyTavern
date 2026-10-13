// A card's content identity: the hash two copies of one card share however each was installed. Imports nothing of
// the server's, so the library engine and the import workers can use it.
import crypto from 'node:crypto';

import _ from 'lodash';

/**
 * Strips fav/data.extensions.fav/chat/create_date for content-identity comparison, so two independently
 * imported copies of the same card hash identically. Returns a deep clone; never mutates `char`.
 */
export function stripInstallLocalFields(char) {
    const clone = _.cloneDeep(char);
    _.unset(clone, 'fav');
    _.unset(clone, 'data.extensions.fav');
    _.unset(clone, 'chat');
    _.unset(clone, 'create_date');
    return clone;
}

/**
 * sha256 over a canonical (sorted-keys) JSON serialization of the character with install-local fields stripped.
 * @returns {string} sha256 hex digest
 */
export function computeContentIdentityHash(character) {
    const stripped = stripInstallLocalFields(character);
    return crypto.createHash('sha256').update(canonicalStringify(stripped)).digest('hex');
}

/**
 * JSON.stringify with object keys sorted at every level, for deterministic output regardless of insertion order.
 * @param {*} value
 * @returns {string}
 */
function canonicalStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        // Skip undefined-valued keys, matching JSON.stringify()'s own omission semantics — otherwise hashes
        // differ depending on whether the object was round-tripped through JSON before reaching here.
        const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
