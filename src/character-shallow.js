import { shallowCharacterData } from '../public/scripts/hash-utils.js';

/**
 * @param {object} data
 * @returns {number}
 */
export function calculateDataSize(data) {
    return typeof data === 'object' ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0) : 0;
}

/**
 * @param {object} character
 * @returns {{shallow: true, [key: string]: any}}
 */
export function toShallow(character) {
    return {
        shallow: true,
        name: character.name,
        avatar: character.avatar,
        thumbnail: character.thumbnail,
        avatar_ref: character.avatar_ref,
        chat: character.chat,
        fav: character.fav,
        date_added: character.date_added,
        create_date: character.create_date,
        date_last_chat: character.date_last_chat,
        chat_size: character.chat_size,
        data_size: character.data_size,
        tags: character.tags,
        tag_ids: character.tag_ids,
        data: shallowCharacterData(character),
    };
}
