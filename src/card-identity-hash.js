import crypto from 'node:crypto';

export function stripInstallLocalFields(char) {
    const clone = structuredClone(char);
    delete clone.fav;
    delete clone.data?.extensions?.fav;
    delete clone.chat;
    delete clone.create_date;
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
