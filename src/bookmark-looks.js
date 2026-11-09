import { TYPE } from './library-codes.js';

// A bookmark is a chat's position, not a library entity, so its look is an entity of its own under this key.
export const BOOKMARK_LOOK = 'bookmark:';

/**
 * The deletes of the looks of bookmarks being deleted, for the same commit.
 * @param {any} store
 * @param {(string | bigint)[]} bookmarks
 */
export async function bookmarkLookDeletes(store, bookmarks) {
    if (bookmarks.length === 0) return [];
    const ids = await store.libraryIds(bookmarks.map(b => [TYPE.look, `${BOOKMARK_LOOK}${b}`]));
    return ids.filter(id => id !== null).map(entity => ({ kind: 'entityDelete', entity }));
}
