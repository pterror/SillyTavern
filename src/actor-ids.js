/**
 * The ids a store gives outside keys (a message's old id, a session's UUID, a user's handle), and the counters of
 * ids its writers hand out. One `NextIds` per store, shared by its chat and world-info writers, so no two hand out
 * the same id.
 */

/** `chatRead('ids')` spaces. */
export const SPACE = Object.freeze({ message: 0, session: 1, user: 2 });

/**
 * @typedef {{ message: bigint, position: bigint, user: bigint, change: bigint }} NextIds The next id of each space a
 * writer hands out (`chatRead('nextIds')`).
 */

/**
 * The id of an outside key in a space, and the records making it when it names nothing yet.
 * @param {any} store The engine's `Store`.
 * @param {NextIds} next
 * @param {number} space
 * @param {string} key
 * @param {'position' | 'user'} counter
 * @param {object[]} records Gets the `keyMap` record of a new id.
 */
export async function idOf(store, next, space, key, counter, records) {
    const [id] = await store.chatRead('ids', { space, keys: [key] });
    if (id !== null) return id;
    const made = next[counter]++;
    records.push({ kind: 'keyMap', [space === SPACE.user ? 'user' : 'session']: made, key: Buffer.from(key, 'utf8') });
    return made;
}

/**
 * The actor's ids, making the user's and session's keys when they have none.
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
