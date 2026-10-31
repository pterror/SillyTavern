export const ITEMIZED_PROMPT_FLAG = 'has_itemized_prompt';

/** @typedef {Record<string, unknown>} Itemization */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} pagePart
 * @param {unknown} serverPart
 * @returns {Itemization | null}
 */
export function itemizationOf(pagePart, serverPart) {
    const page = isPlainObject(pagePart) ? pagePart : null;
    const server = isPlainObject(serverPart) ? serverPart : null;
    if (!page && !server) return null;
    const entry = { ...page, ...server };
    delete entry.mesId;
    return entry;
}
