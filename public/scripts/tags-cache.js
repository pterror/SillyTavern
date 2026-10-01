import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';

/**
 * Deletes this user's copy of every tag definition that earlier versions kept in IndexedDB. Tags are now read by id
 * when something shows them, so the copy is never read again and only takes up the browser's storage.
 * @returns {Promise<void>}
 */
export async function dropOldTagsCache() {
    try {
        await localforage.dropInstance({ name: `SillyTavern_TagsCache_${getCurrentUserHandle()}` });
    } catch (error) {
        console.warn('Could not delete the old tag cache from browser storage:', error);
    }
}
