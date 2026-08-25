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
 * calculateGroupChatStats - the group equivalent of calculateChatSize() above, for the groups-schema extension
 * (design doc's character-data-residency-redesign, owner decision: give `groups` the same fav/date_added/
 * date_last_chat/chat_size columns characters already have). A character has exactly one chats directory named
 * after it; a group instead owns a *set* of chat ids (`group.chats`) living flat in one shared `groupChats`
 * directory alongside every other group's chats - so this takes the group's own chat-id list and stats only
 * those specific files by name, rather than reading the whole `groupChats` directory and filtering (the shape
 * getGroupsData() in src/endpoints/groups.js used to use inline) - bounded by this one group's chat count, not
 * by how many chats exist across every group. Shared by getGroupsData() (groups.js) and
 * character-metadata-db.js's write-path hook (bumpGroupChatStats()) and bootstrap backfill
 * (bootstrapGroupsIfNeeded()), for the same "compute this once, not per caller" reason calculateChatSize() above
 * is already shared.
 * @param {string} groupChatsDir `directories.groupChats`
 * @param {string[]} chatIds `group.chats` - a group's own array of chat ids (NOT filenames; `.jsonl` is appended)
 * @returns { {chatSize: number, dateLastChat: number} }
 */
export function calculateGroupChatStats(groupChatsDir, chatIds) {
    let chatSize = 0;
    let dateLastChat = 0;

    if (Array.isArray(chatIds)) {
        for (const chatId of chatIds) {
            try {
                const chatStat = fs.statSync(path.join(groupChatsDir, `${chatId}.jsonl`));
                chatSize += chatStat.size;
                dateLastChat = Math.max(dateLastChat, chatStat.mtimeMs);
            } catch (err) {
                // A chat id listed in group.chats but missing on disk (deleted out from under the group, or a
                // chat that was never actually written) simply doesn't contribute - same tolerance
                // getGroupsData()'s old inline version had via its `chats.includes(...)` membership check, which
                // silently skipped any group.chats entry with no matching file.
                if (err.code !== 'ENOENT') throw err;
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
        tag_ids: character.tag_ids,
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
