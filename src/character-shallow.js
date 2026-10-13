import { getConfigValue } from './util.js';
import { shallowCharacterData } from '../public/scripts/hash-utils.js';

// Whether the shallow character response includes creator_notes (matches upstream SillyTavern's shallow response)
export const shallowCharactersIncludeCreatorNotes = !!getConfigValue('performance.shallowCharactersIncludeCreatorNotes', false, 'boolean');

/**
 * Calculate the total string length of the data object.
 * @param {object} data Character `data` object (Spec V2)
 * @returns {number} Total string length across every value in `data`
 */
export function calculateDataSize(data) {
    return typeof data === 'object' ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0) : 0;
}

/**
 * Only get fields that are used to display the character list.
 * @param {object} character Must already carry date_added/create_date/date_last_chat/chat_size/data_size.
 * @returns {{shallow: true, [key: string]: any}} Shallow character
 */
export function toShallow(character) {
    return {
        shallow: true,
        name: character.name,
        avatar: character.avatar,
        chat: character.chat,
        fav: character.fav,
        date_added: character.date_added,
        create_date: character.create_date,
        date_last_chat: character.date_last_chat,
        chat_size: character.chat_size,
        data_size: character.data_size,
        tags: character.tags,
        tag_ids: character.tag_ids,
        data: shallowCharacterData(character, shallowCharactersIncludeCreatorNotes),
    };
}
