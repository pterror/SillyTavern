export const SPACE = Object.freeze({ message: 0, session: 1, user: 2 });

/** @typedef {{ message: bigint, position: bigint, user: bigint, change: bigint }} NextIds */

/**
 * @param {any} store
 * @param {NextIds} next
 * @param {number} space
 * @param {string} key
 * @param {'position' | 'user'} counter
 * @param {object[]} records
 */
export async function idOf(store, next, space, key, counter, records) {
    const [id] = await store.chatRead('ids', { space, keys: [key] });
    if (id !== null) return id;
    const made = next[counter]++;
    records.push({ kind: 'keyMap', [space === SPACE.user ? 'user' : 'session']: made, key: Buffer.from(key, 'utf8') });
    return made;
}

/**
 * @param {any} store
 * @param {NextIds} next
 * @param {{ user: string, session?: string | null }} actor
 * @param {object[]} records
 */
export async function actorIds(store, next, actor, records) {
    const user = await idOf(store, next, SPACE.user, actor.user, 'user', records);
    const session = actor.session ? await idOf(store, next, SPACE.session, actor.session, 'position', records) : null;
    return { user, session };
}
