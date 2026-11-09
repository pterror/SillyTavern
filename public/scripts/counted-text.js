import { getStringHash } from './hash-utils.js';

/**
 * @param {unknown} extra
 * @param {unknown} mes
 * @returns {string}
 */
export function countedText(extra, mes) {
    const reasoning = extra && typeof extra === 'object' ? /** @type {Record<string, unknown>} */ (extra).reasoning : undefined;
    return (typeof reasoning === 'string' ? reasoning : '') + (typeof mes === 'string' ? mes : '');
}

/**
 * @param {unknown} extra
 * @param {unknown} mes
 * @returns {number}
 */
export function countedTextHash(extra, mes) {
    return getStringHash(countedText(extra, mes));
}
