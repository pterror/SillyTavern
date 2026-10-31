import { createHash } from 'node:crypto';

/**
 * @param {string} handle
 * @param {string} hint
 */
export function keyOf(handle, hint) {
    const h = createHash('sha256').update(`${handle}\u0000${hint}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
