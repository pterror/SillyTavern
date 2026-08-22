import fs from 'node:fs';
import path from 'node:path';

import _ from 'lodash';

import { getConfigValue } from './util.js';

// Whether the shallow character response includes creator_notes (matches upstream SillyTavern's shallow response)
const shallowCharactersIncludeCreatorNotes = !!getConfigValue('performance.shallowCharactersIncludeCreatorNotes', false, 'boolean');

/**
 * calculateChatSize - Calculates the total chat size for a given character.
 *
 * Factored out of src/endpoints/characters.js (alongside toShallow()/calculateDataSize() below) so it can be
 * shared, one-way, with character-metadata-db.js - see that module's header, and character-card-normalize.js's
 * header, for why: the phase-1 SQLite metadata store's backfill/reconcile/watch paths need to compute the exact
 * same derived fields characters.js's processCharacter() does, and importing processCharacter() itself (or
 * having characters.js's write-path hooks call back into a metadata module that imports characters.js) would be
 * the same import-cycle shape this codebase has already been bitten by once (see tags-data.js's header).
 * @param  {string} charDir The directory where the chats are stored.
 * @return { {chatSize: number, dateLastChat: number} }         The total chat size.
 */
export function calculateChatSize(charDir) {
    let chatSize = 0;
    let dateLastChat = 0;

    if (fs.existsSync(charDir)) {
        const chats = fs.readdirSync(charDir);
        if (Array.isArray(chats) && chats.length) {
            for (const chat of chats) {
                const chatStat = fs.statSync(path.join(charDir, chat));
                chatSize += chatStat.size;
                dateLastChat = Math.max(dateLastChat, chatStat.mtimeMs);
            }
        }
    }

    return { chatSize, dateLastChat };
}

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
 * @param {object} character Character object - must already carry date_added/create_date/date_last_chat/
 * chat_size/data_size (characters.js's processCharacter() computes these from disk before calling this;
 * character-metadata-db.js computes them itself from the metadata row/live stat, since it can't call
 * processCharacter() - see this module's header).
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
        data: {
            name: _.get(character, 'data.name', ''),
            character_version: _.get(character, 'data.character_version', ''),
            creator: _.get(character, 'data.creator', ''),
            tags: _.get(character, 'data.tags', []),
            ...(shallowCharactersIncludeCreatorNotes && { creator_notes: _.get(character, 'data.creator_notes', '') }),
            extensions: {
                fav: _.get(character, 'data.extensions.fav', false),
                world: _.get(character, 'data.extensions.world', ''),
            },
        },
    };
}
