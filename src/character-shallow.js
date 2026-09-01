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
 * Answers "which group owns this chat, and what else does it own" - the (owner id, file list) pair that every
 * group-side tree operation needs and that no group route is actually handed.
 *
 * A character route receives its owner directly (`avatar_url`) and the owner's chats are simply the contents of
 * a directory named after it. Neither holds for groups: the routes receive `group.chat_id` (a *chat's* id, never
 * the group's own), and all chats of all groups live flat in one shared `groupChats` directory, so the only
 * statement anywhere of which chat ids belong to which group is the group descriptor's own `chats` array. Both
 * halves of the answer come from the same file, which is why this returns them together rather than making
 * callers re-read it.
 *
 * Two ways in, same answer:
 * - `groupId` known (our own client always knows it): one direct read of that descriptor.
 * - `groupId` absent (the stock API shape, which carries no group id at all): scan `groupsDir` for the descriptor
 *   whose `chats` contains `chatId`. Affordable here in a way it would not be for characters - groups are a
 *   user-curated set, nowhere near the scale the residency redesign guards against - and this is the lookup
 *   bumpGroupChatStats() has always done on every single group save anyway.
 *
 * A supplied `groupId` is checked for existence but NOT for membership of `chatId`: a chat that was just created
 * client-side is legitimately not in the descriptor yet, and refusing it would break the very first save of every
 * new group chat.
 *
 * @param {string} groupsDir `directories.groups`
 * @param {object} params
 * @param {string} [params.chatId] A chat id owned by the group, used for the scan when `groupId` is absent
 * @param {string} [params.groupId] The group's own persistent id, when the caller knows it
 * @returns {{ id: string, chats: string[] } | null} `null` when no group claims this chat (also covers an
 * unreadable/missing groups directory). A null is emphatically not "assume it's fine" - a group chat whose owner
 * cannot be established has no addressable place in the tree, and callers must surface that rather than writing
 * it somewhere nothing will read again.
 */
export function resolveGroupOwner(groupsDir, { chatId, groupId } = {}) {
    if (!fs.existsSync(groupsDir)) return null;

    const readDescriptor = (filePath) => {
        try {
            const group = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (typeof group?.id !== 'string') return null;
            return { id: group.id, chats: Array.isArray(group.chats) ? group.chats : [] };
        } catch {
            // An unreadable/corrupt descriptor is skipped, the same tolerance getGroupsData() and
            // bootstrapGroupsIfNeeded() already have for this exact directory.
            return null;
        }
    };

    if (typeof groupId === 'string' && groupId) {
        // path.basename pins the read inside groupsDir - the id reaches here from a request body.
        const fileName = `${path.basename(groupId)}.json`;
        const filePath = path.join(groupsDir, fileName);
        if (fs.existsSync(filePath)) {
            const resolved = readDescriptor(filePath);
            if (resolved) return resolved;
        }
        // A group id that names nothing readable falls through to the scan rather than failing outright:
        // the chat id may still identify its owner, and answering correctly beats answering fast.
    }

    if (typeof chatId !== 'string' || !chatId) return null;

    for (const file of fs.readdirSync(groupsDir).filter(f => f.endsWith('.json'))) {
        const resolved = readDescriptor(path.join(groupsDir, file));
        if (resolved?.chats.includes(chatId)) return resolved;
    }
    return null;
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
