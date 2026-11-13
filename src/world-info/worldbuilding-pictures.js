import { lookImageUrl } from '@st/looks/look';

/**
 * Every entry card in `read` with its picture's id as the picture's URL.
 * @template T
 * @param {T} read
 * @returns {T}
 */
export function withPictureUrls(read) {
    /** @param {unknown} part */
    const walk = part => {
        if (Array.isArray(part)) {
            part.forEach(walk);
            return;
        }
        if (typeof part !== 'object' || part === null) return;
        const cell = /** @type {Record<string, unknown>} */ (part);
        if (cell.cell === 'entry' && typeof cell.picture === 'string') cell.picture = lookImageUrl(cell.picture);
        Object.values(cell).forEach(walk);
    };
    walk(read);
    return read;
}
