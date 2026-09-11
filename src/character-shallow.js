import fs from 'node:fs';
import path from 'node:path';

import _ from 'lodash';

import { getConfigValue } from './util.js';

// Whether the shallow character response includes creator_notes (matches upstream SillyTavern's shallow response)
const shallowCharactersIncludeCreatorNotes = !!getConfigValue('performance.shallowCharactersIncludeCreatorNotes', false, 'boolean');

/**
 * Calculates the total chat size for a given character.
 * @param {string} charDir The directory where the chats are stored.
 * @returns {{chatSize: number, dateLastChat: number}}
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
 * The group equivalent of calculateChatSize(): a group owns a set of chat ids (`group.chats`) living flat in
 * one shared `groupChats` directory, so this stats only those specific files rather than scanning the directory.
 * @param {string} groupChatsDir `directories.groupChats`
 * @param {string[]} chatIds `group.chats` - chat ids, not filenames (`.jsonl` is appended)
 * @returns {{chatSize: number, dateLastChat: number}}
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
                // A chat id listed but missing on disk simply doesn't contribute.
                if (err.code !== 'ENOENT') throw err;
            }
        }
    }

    return { chatSize, dateLastChat };
}

/**
 * Resolves which group owns a chat. Unlike characters, groups carry no direct owner reference on a chat route
 * (`group.chat_id` names the chat, not the group), so this reads the group descriptor(s) to find it: a direct
 * read when `groupId` is known, otherwise a scan of `groupsDir` for a descriptor whose `chats` contains `chatId`.
 *
 * A supplied `groupId` is checked for existence but not for membership of `chatId` — a chat just created
 * client-side is legitimately not in the descriptor yet.
 * @param {string} groupsDir `directories.groups`
 * @param {object} params
 * @param {string} [params.chatId] A chat id owned by the group, used for the scan when `groupId` is absent
 * @param {string} [params.groupId] The group's own persistent id, when the caller knows it
 * @returns {{ id: string, chats: string[] } | null} `null` when no group claims this chat.
 */
export function resolveGroupOwner(groupsDir, { chatId, groupId } = {}) {
    if (!fs.existsSync(groupsDir)) return null;

    const readDescriptor = (filePath) => {
        try {
            const group = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (typeof group?.id !== 'string') return null;
            return { id: group.id, chats: Array.isArray(group.chats) ? group.chats : [] };
        } catch {
            return null;
        }
    };

    if (typeof groupId === 'string' && groupId) {
        // path.basename pins the read inside groupsDir - groupId comes from a request body.
        const fileName = `${path.basename(groupId)}.json`;
        const filePath = path.join(groupsDir, fileName);
        if (fs.existsSync(filePath)) {
            const resolved = readDescriptor(filePath);
            if (resolved) return resolved;
        }
        // Falls through to the scan below rather than failing outright.
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
