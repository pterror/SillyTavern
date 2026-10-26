import { createHash } from 'node:crypto';

/**
 * The key of what `hint` names for a user (a connection of a source, an entry without an id of its own): a uuid
 * made from them, so converting again, or re-importing on a save, gives the same one.
 * @param {string} handle
 * @param {string} hint
 */
export function keyOf(handle, hint) {
    const h = createHash('sha256').update(`${handle}\u0000${hint}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
