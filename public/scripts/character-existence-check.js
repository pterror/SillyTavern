import { characterRepository } from './character-repository.js';

/**
 * @param {string[]} ids
 * @returns {Promise<Record<string, boolean>|null>} `null` means the check itself failed - callers must treat that as unverifiable, never as "these don't exist".
 */
export async function checkCharactersExistOrNull(ids) {
    if (ids.length === 0) return {};
    try {
        return await characterRepository.exists(ids);
    } catch (error) {
        console.error('Character existence check failed, treating as unverifiable (not as nonexistent):', error);
        return null;
    }
}
