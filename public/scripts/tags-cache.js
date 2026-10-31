import { localforage } from '../lib.js';
import { getCurrentUserHandle } from './user.js';

/**
 * @returns {Promise<void>}
 */
export async function dropOldTagsCache() {
    try {
        await localforage.dropInstance({ name: `SillyTavern_TagsCache_${getCurrentUserHandle()}` });
    } catch (error) {
        console.warn('Could not delete the old tag cache from browser storage:', error);
    }
}
