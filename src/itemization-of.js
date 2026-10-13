/** The `extra` key marking a reply that has a stored prompt itemization. */
export const ITEMIZED_PROMPT_FLAG = 'has_itemized_prompt';

/**
 * @typedef {Record<string, unknown>} Itemization A reply's prompt itemization: what the page's "Prompt" view reads.
 * Stored without `mesId`; the page gives an entry the position of its message when it reads one.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The itemization stored with a generated reply: what the page put into the prompt (sent with the generate request),
 * with the server's own breakdown of the prompt it built taking precedence.
 * @param {unknown} pagePart
 * @param {unknown} serverPart
 * @returns {Itemization | null} null when neither side has one.
 */
export function itemizationOf(pagePart, serverPart) {
    const page = isPlainObject(pagePart) ? pagePart : null;
    const server = isPlainObject(serverPart) ? serverPart : null;
    if (!page && !server) return null;
    const entry = { ...page, ...server };
    delete entry.mesId;
    return entry;
}
