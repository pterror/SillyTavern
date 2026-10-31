import crypto from 'node:crypto';

import _ from 'lodash';

export function stripInstallLocalFields(char) {
    const clone = _.cloneDeep(char);
    _.unset(clone, 'fav');
    _.unset(clone, 'data.extensions.fav');
    _.unset(clone, 'chat');
    _.unset(clone, 'create_date');
    return clone;
}

/**
 * @returns {string}
 */
export function computeContentIdentityHash(character) {
    const stripped = stripInstallLocalFields(character);
    return crypto.createHash('sha256').update(canonicalStringify(stripped)).digest('hex');
}

/**
 * @param {*} value
 * @returns {string}
 */
function canonicalStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
