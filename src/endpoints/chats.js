import fs from 'node:fs';
import path from 'node:path';

import readline from 'node:readline';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import {
    humanizedDateTime,
    tryParse,
    formatBytes,
    isPathUnderParent,
} from '../util.js';
import { getCharacterActiveChatsByIds, setCharacterActiveChat } from '../character-metadata-db.js';
import { resolveGroupOwner } from '../character-shallow.js';
import { readGroupFile, writeGroupFile } from './groups.js';
import { withGroupLock } from '../group-lock.js';
import { readCardContent } from './characters.js';
import { triggerAutoSave } from './settings.js';
import { readAllSettingsAsJson, readSettingsAtPaths, writeSettingsKeys } from '../settings-store.js';
import { getStringHash } from '../../public/scripts/hash-utils.js';
import { cardToGreetingsModel } from '../greeting-list.js';
import { applyPageWrites } from '../page-writes.js';
import { storedMessagesOf } from '../stored-messages.js';
import {
    isAvailable as isTreeAvailable, hasSavedChats,
    saveChatToTree, loadBranch, forkBranch, labelNode,
    deleteBranch, renameBranch as renameBranchInTree, listBranches, listRecentBranches, searchBranchesByContent,
    ownerDescriptorOf, renameCharacterInMessages, renameGroupMemberInMessages, getAlternatives, getContinuation, getAncestorPath, editMessage, editMessages, appendMessages, addAlternatives, setChatMetadata, getOpeningAlternatives, loadDefaultChain, storedSendKeys, chooseCardOpening, findOpeningToLandOn, LANDING_EDITS_MAX, addOpeningAlternatives, loadAtNode, mergeChatMetadataKeys, listLabels, setNodeMetadata, selectDefaultChild, endPathAt, endPathAtAnchor, graftMessage, degraftRange, swapAdjacent, deleteAlternative,
} from '../message-tree-db.js';

/**
 * @typedef {import('../message-tree-db.js').Directories} Directories
 * @typedef {import('../message-tree-db.js').TreeChatMessage} TreeChatMessage
 * @typedef {import('../message-tree-db.js').ChatHeaderLike} ChatHeaderLike
 */

/**
 * @param {unknown} error
 * @returns {error is { code: string }}
 */
function hasErrorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

export const CHAT_BACKUPS_PREFIX = 'chat_';

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (lastMessage == null || lastMessage === '') {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

/**
 * @typedef {object} OobaChatData
 * @property {string[][]} data_visible Each entry is a `[userTurn, characterTurn]` pair of message text.
 */

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {OobaChatData} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: new Date().toISOString(),
                mes: arr[0],
                extra: {},
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: new Date().toISOString(),
                mes: arr[1],
                extra: {},
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * @typedef {object} AgnaiChatData
 * @property {{ userId?: string, msg: string }[]} messages
 */

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {AgnaiChatData} jsonData Chat data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.messages) {
        const isUser = message.userId != null && message.userId !== '';
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: new Date().toISOString(),
            mes: message.msg,
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * @typedef {object} CAIChatHistory
 * @property {{ src: { is_human: boolean }, text: string }[]} msgs
 */

/**
 * @typedef {object} CAIChatData
 * @property {{ histories?: CAIChatHistory[] }} histories
 */

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {CAIChatData} jsonData JSON data
 * @returns {string[]} Converted data, one serialized chat (joined JSONL) per history
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {CAIChatHistory} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: new Date().toISOString(),
            mes: msg.text,
            extra: {},
        }));

        return [starter, ...historyData];
    }

    // BEHAVIOR CHANGE (bug fix, flagged per task instructions): this previously read `newChats` from
    // inside the very `.map()` callback building it, which throws a ReferenceError (TDZ) on `const`
    // before the assignment completes - CAI Tools import was unconditionally broken. Fixed to build the
    // array from the map's own return value instead of self-referentially calling Array#push on it.
    const newChats = (jsonData.histories.histories ?? []).map(history => convert(history).map(obj => JSON.stringify(obj)).join('\n'));
    return newChats;
}

/**
 * @typedef {object} KoboldLiteChatData
 * @property {{ chatname: string, chatopponent: string }} savedsettings
 * @property {string[]} actions
 * @property {string} [prompt]
 */

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {KoboldLiteChatData} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @param {string} msg */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? userName : characterName,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: new Date().toISOString(),
            extra: {},
        };
    }

    // Create the header
    const userName = String(data.savedsettings.chatname);
    const characterName = String(data.savedsettings.chatopponent).split('||$||')[0];
    const header = {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt != null && data.prompt !== '') {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    /** @param {unknown} swipe */
    function flattenSwipe(swipe) {
        return (swipe && typeof swipe === 'object' && 'message' in swipe) ? swipe.message : swipe;
    }

    /** @param {string} line */
    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map((/** @type {unknown} */ swipe) => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return lines.map(convert).join('\n');
}

/**
 * @typedef {object} RisuChatData
 * @property {{ message: { role: string, name?: string, time?: number|string, data?: string }[] }} data
 */

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {RisuChatData} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: new Date(Number(message.time ?? Date.now())).toISOString(),
            mes: message.data ?? '',
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The name of the chat file (without extension)
 * @property {string} [file_name] - The name of the chat file (with extension)
 * @property {string} [file_size] - The size of the chat file in a human-readable format
 * @property {number} [chat_items] - The number of chat items in the file
 * @property {string} [mes] - The last message in the chat
 * @property {number|string} [last_mes] - The timestamp of the last message
 * @property {object} [chat_metadata] - Additional chat metadata
 * @property {boolean} [match] - Whether the chat matches the search criteria
 */

/**
 * Reads the information from a chat file.
 * @param {string} pathToFile - Path to the chat file
 * @param {Record<string, unknown>} additionalData - Additional data to include in the result
 * @param {boolean} withMetadata - Whether to read chat metadata
 * @param {ChatMatchFunction|null} matcher - Optional function to match messages
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: (string|null)[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(pathToFile, additionalData = {}, withMetadata = false, matcher = null) {
    const parsedPath = path.parse(pathToFile);
    const hasMatcher = (typeof matcher === 'function');

    // A chat that is deleted while a scan is running is not an error: treat it like a corrupted chat and move on.
    const chatVanished = () => {
        console.warn('Chat file was deleted while it was being scanned:', pathToFile);
        return /** @type {ChatInfo} */ ({ match: false });
    };

    let stats;
    try {
        stats = await fs.promises.stat(pathToFile);
    } catch (error) {
        if (hasErrorCode(error) && error.code === 'ENOENT') {
            return chatVanished();
        }
        throw error;
    }

    /** @type {ChatInfo} */
    const chatData = {
        match: false,
        file_id: parsedPath.name,
        file_name: parsedPath.base,
        file_size: formatBytes(stats.size),
        chat_items: 0,
        mes: '[The chat is empty]',
        last_mes: stats.mtimeMs,
        ...additionalData,
    };

    if (stats.size === 0) {
        return chatData;
    }

    return new Promise((res, rej) => {
        const fileStream = fs.createReadStream(pathToFile);

        // The file can still disappear between the stat above and the stream opening
        fileStream.on('error', (/** @type {NodeJS.ErrnoException} */ error) => {
            if (error.code === 'ENOENT') {
                res(chatVanished());
                return;
            }
            rej(error);
        });

        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        // readline re-emits input stream errors; without a listener the emit throws
        rl.on('error', (/** @type {NodeJS.ErrnoException} */ error) => {
            if (error.code === 'ENOENT') {
                res(chatVanished());
                return;
            }
            rej(error);
        });

        /** @type {string|undefined} */
        let lastLine;
        let itemCounter = 0;
        let hasAnyMatch = false;
        /** @type {string[]} */
        let matchBuffer = [];
        rl.on('line', (line) => {
            if (withMetadata && itemCounter === 0) {
                const jsonData = tryParse(line);
                if (jsonData && _.isObjectLike(jsonData.chat_metadata)) {
                    chatData.chat_metadata = jsonData.chat_metadata;
                }
            }
            // Skip matching if any match was already found
            if (hasMatcher && !hasAnyMatch && itemCounter > 0) {
                const jsonData = tryParse(line);
                if (jsonData) {
                    matchBuffer.push(jsonData.mes || '');
                    if (matcher(matchBuffer)) {
                        hasAnyMatch = true;
                        matchBuffer = [];
                    }
                }
            }
            itemCounter++;
            lastLine = line;
        });
        rl.on('close', () => {
            if (lastLine != null && lastLine !== '') {
                const jsonData = tryParse(lastLine);
                if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                    chatData.chat_items = (itemCounter - 1);
                    chatData.mes = jsonData.mes || '[The message is empty]';
                    chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
                    chatData.match = hasMatcher ? hasAnyMatch : true;

                    res(chatData);
                } else {
                    // The last line is unparseable or lacks known fields (e.g. a truncated write or an external edit).
                    // Resolve a degraded preview from the stat data instead of hiding an otherwise intact chat
                    // from the chat list, search and recents.
                    console.warn('Found an invalid or corrupted last line in a chat file:', pathToFile);
                    // Exclude both the metadata line and the unreadable trailing line.
                    chatData.chat_items = Math.max(itemCounter - 2, 0);
                    chatData.mes = '[The message is empty]';
                    chatData.match = hasMatcher ? hasAnyMatch : true;
                    res(chatData);
                }
            } else {
                // The file was truncated after the stat reported a non-zero size; treat it like an empty chat
                res(chatData);
            }
        });
    });
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
    /** @param {ConstructorParameters<typeof Error>} params */
    constructor(...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);
        // Maintains proper stack trace for where our error was thrown (non-standard, but always
        // present in this server's Node/V8 runtime).
        Error.captureStackTrace(this, IntegrityMismatchError);
        this.date = new Date();
    }
}

/**
 * Picks a branch name that doesn't already exist for this owner, for callers that only have a desired
 * base name (e.g. "Some Chat") and want the server - not a client-fetched chat list - to be the source
 * of truth for uniqueness. Mirrors labelNode()'s "<name> - Branch #N" scheme. Checked against the tree
 * DB itself (listBranches()), the only place a chat name is actually registered now that /save no
 * longer ever writes a JSONL file - a directory listing would never find a collision.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @param {string} baseName Desired chat name, without extension.
 * @returns {Promise<string>} `baseName` unchanged if free, otherwise `<baseName> - Branch #N` for the first free N.
 */
async function pickUniqueChatFileName(directories, ownerId, baseName) {
    const existing = new Set((await listBranches(directories, ownerId)).map(b => b.name));
    if (!existing.has(baseName)) {
        return baseName;
    }
    const cleanBase = String(baseName).replace(/ - Branch #\d+$/, '');
    let i = 1;
    while (existing.has(`${cleanBase} - Branch #${i}`)) i++;
    return `${cleanBase} - Branch #${i}`;
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        let chatName = String(request.body.file_name);

        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }

        // Whole-array save: our own frontend uses this on the normal path too (a fresh chat's first
        // save, and tree-chat snapshots), alongside the named per-row operations for everything else.
        const owner = ownerDescriptorOf({ avatar: request.body.avatar_url });

        // A fresh branch/bookmark save asks for a name minted here (like /chats/label's unique:true)
        // instead of asserting a name the client uniquified against its own fetched chat list.
        if (request.body.unique) {
            chatName = await pickUniqueChatFileName(request.user.directories, cardName, chatName);
        }

        const result = await saveChatToTree(request.user.directories, cardName, chatName, chatData, false, owner);
        if (result && 'integrity' in result) {
            return response.send({
                ok: true,
                integrity: result.integrity,
                assigned_node_ids: result.assignedNodeIds,
                file_name: chatName,
            });
        }

        // Nothing to save (chatData had no messages beyond the header). Not an error - the client
        // still expects an { ok: true } response with the name it asked to save under.
        return response.send({ ok: true, file_name: chatName });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatName = String(request.body.file_name || '');

        if (chatName) {
            // The pointer may be a node id (exact) or a legacy chat name (looked up, not unique per owner);
            // both are accepted so an existing pointer keeps working while the client moves over.
            const result = await loadAtNode(request.user.directories, dirName, chatName)
                ?? await loadBranch(request.user.directories, dirName, chatName);
            if (result) {
                /** @type {any} */
                const header = {
                    chat_metadata: { ...result.metadata },
                    user_name: 'unused',
                    character_name: 'unused',
                };
                return response.send([header, ...result.messages]);
            }
            // A 404 (rather than {}) here lets the client distinguish "stale pointer to a gone chat" from
            // a legitimately new/unsaved chat and trigger recovery instead of silently rendering blank.
            return response.status(404).send({ error: 'not_found' });
        }

        // No file_name: an empty chat, as upstream answers it.
        return response.send({});
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

/**
 * Records which character or group the user last opened (the `active_character` and `active_group` settings),
 * when it changed.
 * @param {import('express').Request} request
 * @param {{ character: string|null, group: string|null }} opened
 * @returns {{ active_character: string|null, active_group: string|null, settings_hash?: number }} The stored values;
 * `settings_hash` (the whole settings' hash, as /api/settings answers it) when they were written.
 */
function recordLastOpened(request, opened) {
    const directories = request.user.directories;
    const current = readSettingsAtPaths(directories, ['active_character', 'active_group']);
    const stored = { active_character: opened.character, active_group: opened.group };
    if ((current.active_character ?? null) === stored.active_character && (current.active_group ?? null) === stored.active_group) {
        return stored;
    }
    writeSettingsKeys(directories, stored);
    triggerAutoSave(request.user.profile.handle);
    return { ...stored, settings_hash: getStringHash(readAllSettingsAsJson(directories)) };
}

/**
 * A card's openings as the page draws them: the first window (`openings`, as /openings answers an empty body) and,
 * when the card has greetings with no row, all of those (`card_openings`, as /openings answers `{ offset: stored,
 * limit: card-only count }`).
 * @param {Directories} directories
 * @param {string} ownerId
 * @param {string} avatar
 */
async function openingsForPage(directories, ownerId, avatar) {
    const cardGreetings = await _cardGreetingsFromDisk(directories, avatar);
    const openings = await getOpeningAlternatives(directories, ownerId, {}, cardGreetings);
    if (!openings) return { openings: null, card_openings: null };
    const stored = openings.stored;
    const cardOnly = openings.total - stored;
    const cardOpenings = cardOnly > 0
        ? await getOpeningAlternatives(directories, ownerId, { offset: stored, limit: cardOnly }, cardGreetings)
        : null;
    return { openings, card_openings: cardOpenings };
}

/**
 * Opens a character's or a group's conversation: the one named by `chat` (a chat name or node id, as upstream names
 * chats) when it exists, else the one it is on, else (a character) its most recently active bookmark, else the
 * choices last made from its first message, else nothing yet (the card's greetings). With `make_current`, a `chat`
 * that exists becomes the owner's current one. Records which character or group was opened last. Writes only what
 * changed; mints no names and creates nothing on disk.
 *
 * Body: `{ avatar_url }` or `{ group_id }`; optionally `chat`, `make_current`, (a character) `fresh`: open no
 * conversation, only the card's greetings (a new chat), and `send_keys`: keys of sends the page kept because it
 * doesn't know they were stored; `stored_sends` answers those the owner has.
 * Answers `{ chat, chat_metadata, messages, openings, card_openings, active_character, active_group, settings_hash? }`:
 * `chat` is upstream's identifier for the open chat ('' when there is no conversation yet), `messages` as
 * /get answers them after the header; `openings`/`card_openings` for a character only (null for a group);
 * for a group also `chats` and `date_last_chat` as stored. 404 when the character or group doesn't exist.
 */
/**
 * What `/open` answers: resolves which conversation a character or group opens on, records what was opened, and
 * reads everything the screen draws.
 * @param {import('express').Request} request
 * @param {{ avatar_url?: unknown, group_id?: unknown, chat?: unknown, make_current?: unknown, fresh?: unknown, send_keys?: unknown }} body
 * @returns {Promise<{ status: number, answer?: object }>}
 */
async function openChatAnswer(request, body) {
    const directories = request.user.directories;
    const requested = typeof body.chat === 'string' && body.chat !== '' ? body.chat : null;
    const makeCurrent = body.make_current === true;

    if (body.group_id) {
        const groupId = String(body.group_id);
        const opened = await withGroupLock(directories, groupId, async () => {
            const group = readGroupFile(directories, groupId);
            if (!group) return null;
            const chats = Array.isArray(group.chats) ? group.chats : [];
            const target = requested !== null && chats.includes(requested) ? requested : group.chat_id;
            if (makeCurrent && target !== group.chat_id) {
                group.chat_id = target;
                group.date_last_chat = Date.now();
                await writeGroupFile(directories, group);
            }
            return { chatId: String(target ?? ''), chats, dateLastChat: group.date_last_chat };
        });
        if (!opened) return { status: 404 };

        const loaded = opened.chatId
            ? await loadAtNode(directories, groupId, opened.chatId) ?? await loadBranch(directories, groupId, opened.chatId)
            : null;
        return {
            status: 200,
            answer: {
                chat: opened.chatId,
                chat_metadata: { ...(loaded?.metadata ?? {}) },
                messages: loaded?.messages ?? [],
                openings: null,
                card_openings: null,
                chats: opened.chats,
                date_last_chat: opened.dateLastChat,
                stored_sends: await storedSendKeys(directories, groupId, body.send_keys),
                ...recordLastOpened(request, { character: null, group: groupId }),
            },
        };
    }

    const avatar = String(body.avatar_url || '');
    if (!avatar) return { status: 400 };
    const ownerId = avatar.replace('.png', '');
    if ((await readCardContent(directories, avatar)) == null) return { status: 404 };

    const fresh = body.fresh === true;
    const current = (await getCharacterActiveChatsByIds(directories, [avatar]))[avatar] ?? null;
    /** @type {{ messages: TreeChatMessage[], metadata: ChatMetadata } | null} */
    let loaded = null;
    let chatId = '';
    for (const target of fresh ? [] : [requested, current]) {
        if (target === null || loaded) continue;
        loaded = await loadAtNode(directories, ownerId, target) ?? await loadBranch(directories, ownerId, target);
        if (loaded) chatId = target;
    }
    if (loaded && makeCurrent && chatId === requested && requested !== current) {
        await setCharacterActiveChat(directories, avatar, requested);
    }
    if (!loaded && !fresh) {
        const branches = await listBranches(directories, ownerId);
        branches.sort((a, b) => b.last_activity - a.last_activity);
        if (branches.length) {
            loaded = await loadAtNode(directories, ownerId, branches[0].id);
            if (loaded) chatId = branches[0].id;
        }
    }
    if (!loaded && !fresh) {
        loaded = await loadDefaultChain(directories, ownerId);
        chatId = loaded?.messages[0]?.node_id ?? '';
    }

    return {
        status: 200,
        answer: {
            chat: chatId,
            chat_metadata: { ...(loaded?.metadata ?? {}) },
            messages: loaded?.messages ?? [],
            ...await openingsForPage(directories, ownerId, avatar),
            stored_sends: await storedSendKeys(directories, ownerId, body.send_keys),
            ...recordLastOpened(request, { character: avatar, group: null }),
        },
    };
}

router.post('/open', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { status, answer } = await openChatAnswer(request, request.body);
        return answer ? response.send(answer) : response.sendStatus(status);
    } catch (error) {
        console.error('Error opening a chat:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Bookmarks a message: names it `label` (with `unique`, "<label> - Branch #N" when the name is taken). A greeting
 * shown without a row (`opening`) is stored first, as /message/select stores it. The bookmark carries the chat
 * metadata of the chat it was made from (`from`, a node id or chat name), unless the message already has its own.
 * With `also_node_id` (a fork at an alternative) that message, the one shown, is named too. A group's bookmark is
 * added to the group's chats. With `open`, the bookmark is opened as /open opens a chat (`make_current`), and its
 * answer is `opened`.
 */
router.post('/bookmark', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const directories = request.user.directories;
        const ownerId = ownerOf(request);
        const groupId = request.body.group_id ? String(request.body.group_id) : null;
        const label = typeof request.body.label === 'string' ? request.body.label.trim() : '';
        if (!label) return response.status(400).send({ error: 'label is required' });

        let nodeId = String(request.body.node_id || '');
        if (!nodeId && request.body.opening) {
            const written = await applyPageWrites(response, directories, {
                ownerId, avatar: request.body.avatar_url, groupId: groupId ?? undefined,
                body: { node_id: null, opening: request.body.opening, page_metadata: request.body.page_metadata },
            });
            if (!written) return;
            nodeId = storedMessagesOf(response)?.find(s => !('integrity' in s))?.node_id ?? '';
        }
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const labeled = await labelNode(directories, nodeId, label, { ownerId, unique: request.body.unique === true });
        if (!labeled.ok || typeof labeled.label !== 'string' || labeled.label === '') return response.status(409).send({ ok: false, reason: 'unknown message' });
        const name = labeled.label;

        const from = typeof request.body.from === 'string' && request.body.from !== '' ? request.body.from : null;
        if (from !== null && from !== nodeId) {
            const source = await loadAtNode(directories, ownerId, from) ?? await loadBranch(directories, ownerId, from);
            const target = await loadAtNode(directories, ownerId, nodeId);
            const own = Object.keys(target?.metadata ?? {}).filter(key => key !== 'integrity');
            if (source && own.length === 0) {
                const merged = await mergeChatMetadataKeys(directories, ownerId, nodeId, { ...source.metadata, ...(groupId !== null ? { __is_group: true } : {}) }, []);
                if (!merged.ok) return response.status(500).send({ error: 'The bookmark was made, but the chat\'s metadata could not be copied to it.' });
            }
        }

        const alsoNodeId = String(request.body.also_node_id || '');
        if (alsoNodeId && alsoNodeId !== nodeId) {
            await labelNode(directories, alsoNodeId, name, { ownerId });
        }

        /** @type {string[]|undefined} */
        let chats;
        if (groupId !== null) {
            const group = resolveGroupOwner(directories.groups, { groupId });
            if (group) {
                await registerGroupChatIdIfNew(directories, group, name);
                chats = /** @type {{ chats?: string[] } | null} */ (readGroupFile(directories, groupId))?.chats;
            }
        }

        const opened = request.body.open === true
            ? (await openChatAnswer(request, { avatar_url: request.body.avatar_url, group_id: groupId, chat: name, make_current: true, send_keys: request.body.send_keys })).answer
            : undefined;
        return response.send({ ok: true, node_id: nodeId, label: name, chats, opened, stored: storedMessagesOf(response) ?? undefined });
    } catch (error) {
        console.error('Error bookmarking a message:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const oldName = String(request.body.original_file).replace(/\.jsonl$/, '');

        // `avatar_url` means nothing for a group; its owner is resolved from the chat being renamed instead.
        /** @type {string|null} */
        let ownerId = null;
        if (request.body.is_group) {
            ownerId = resolveGroupOwner(request.user.directories.groups, { chatId: oldName, groupId: request.body.group_id })?.id ?? null;
        } else {
            ownerId = String(request.body.avatar_url).replace('.png', '');
        }

        if (ownerId == null || ownerId === '' || !await hasSavedChats(request.user.directories, ownerId)) {
            return response.status(400).send({ error: true });
        }

        const newName = String(request.body.renamed_file).replace(/\.jsonl$/, '');
        const renamed = await renameBranchInTree(request.user.directories, ownerId, oldName, newName);
        if (!renamed) {
            return response.status(400).send({ error: true });
        }
        return response.send({ ok: true, sanitizedFileName: newName });
    } catch (error) {
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Deletes a character's chat (upstream's route). When it was the character's current chat, the character moves to its
 * most recently active remaining chat (`activeChat`, '' when none remains). With `open`, the character's chat is then
 * opened as /open opens it, answered as `opened`.
 */
router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const directories = request.user.directories;
        const avatar = String(request.body.avatar_url);
        const ownerId = avatar.replace('.png', '');
        const chatName = String(request.body.chatfile).replace(/\.jsonl$/, '');

        if (!await hasSavedChats(directories, ownerId)) {
            return response.sendStatus(400);
        }

        // Absent when the character has no current chat.
        const current = /** @type {string|undefined} */ ((await getCharacterActiveChatsByIds(directories, [avatar]))[avatar]) ?? null;
        const deleted = await deleteBranch(directories, ownerId, chatName);
        if (deleted === false) {
            return response.sendStatus(400);
        }
        const opened = async () => request.body.open === true
            ? (await openChatAnswer(request, { avatar_url: avatar, send_keys: request.body.send_keys })).answer
            : undefined;
        // The pointer names the chat by its name or by the message it is at.
        if (current === null || (current !== chatName && current !== deleted)) {
            return response.send({ ok: true, opened: await opened() });
        }
        // Same recency measure listRecentBranches() already sorts by: last_activity (a branch's
        // leaf message), falling back to the label's own creation time for a branch with no
        // activity of its own yet.
        const remaining = await listBranches(directories, ownerId);
        remaining.sort((a, b) => b.last_activity - a.last_activity);
        const activeChat = remaining.length ? remaining[0].id : null;
        await setCharacterActiveChat(directories, avatar, activeChat);
        return response.send({ ok: true, activeChat: activeChat ?? '', opened: await opened() });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Starts a new chat. A character's chat moves to `chat` (the greeting the page shows for a new chat: its stored row's
 * id, or '' for a card greeting with no row); a group gets a new chat id, made its current one, and the answer carries
 * it opened (`opened`, as /open answers). With `replace`, the chat it replaces is deleted, as /delete or /group/delete
 * deletes one, and named in `deleted`.
 */
router.post('/new', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const directories = request.user.directories;
        const replace = typeof request.body.replace === 'string' && request.body.replace !== '' ? request.body.replace : null;
        /** @type {string[]} */
        const deleted = [];

        if (request.body.group_id) {
            const groupId = String(request.body.group_id);
            const made = await withGroupLock(directories, groupId, async () => {
                const group = readGroupFile(directories, groupId);
                if (!group) return null;
                const chatId = String(Date.now());
                const chats = Array.isArray(group.chats) ? group.chats.filter(id => id !== replace) : [];
                group.chats = [...chats, chatId];
                group.chat_id = chatId;
                if (replace !== null && await deleteBranch(directories, groupId, replace) !== false) deleted.push(replace);
                await writeGroupFile(directories, group);
                return { chatId, chats: group.chats };
            });
            if (!made) return response.sendStatus(404);
            const opened = (await openChatAnswer(request, { group_id: groupId, send_keys: request.body.send_keys })).answer;
            return response.send({ ok: true, chat_id: made.chatId, chats: made.chats, deleted, opened });
        }

        const avatar = String(request.body.avatar_url || '');
        if (!avatar) return response.sendStatus(400);
        const ownerId = avatar.replace('.png', '');
        const chat = typeof request.body.chat === 'string' && request.body.chat !== '' ? request.body.chat : null;
        const current = /** @type {string|undefined} */ ((await getCharacterActiveChatsByIds(directories, [avatar]))[avatar]) ?? null;
        if (current !== chat) await setCharacterActiveChat(directories, avatar, chat);
        if (replace !== null && replace !== chat && await deleteBranch(directories, ownerId, replace) !== false) deleted.push(replace);
        return response.send({ ok: true, deleted });
    } catch (error) {
        console.error('Error starting a new chat:', error);
        return response.status(500).send({ error: true });
    }
});

// ---------------------------------------------------------------------------
//  Tree-specific endpoints (fork, label, list-branches)
// ---------------------------------------------------------------------------

/** Deprecated, unused by this frontend (superseded by /label); kept for extensions using the stock API. */
router.post('/fork', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { avatar_url, node_id, branch_name, metadata } = request.body;
        if (!avatar_url || !node_id || !branch_name) {
            return response.sendStatus(400);
        }

        const ownerId = String(avatar_url).replace('.png', '');
        const result = await forkBranch(
            request.user.directories,
            ownerId,
            String(node_id),
            String(branch_name),
            false,
            metadata || {},
        );

        if (result) {
            return response.send({ ok: true, ...result });
        }
        return response.status(400).send({ error: 'Fork failed — message node not found.' });
    } catch (error) {
        console.error('Error creating fork:', error);
        return response.status(500).send({ error: true });
    }
});

/** Labels (pins/checkpoints) a message node - a checkpoint is just a label on an existing node in the tree model. */
router.post('/label', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { avatar_url, group_id, node_id, label, unique } = request.body;
        if (!node_id) {
            return response.sendStatus(400);
        }

        // group_id first, same priority as ownerOf() above - but unlike ownerOf(), left undefined (not
        // the literal string "undefined") when neither is given, since `unique`'s de-duplication scan
        // treats a real ownerId as optional and a bogus one as a real (and wrong) scope to scan.
        const ownerId = group_id ? String(group_id) : (avatar_url ? String(avatar_url).replace('.png', '') : undefined);
        const result = await labelNode(request.user.directories, String(node_id), label || null, { ownerId, unique: !!unique });
        return response.send(result);
    } catch (error) {
        console.error('Error labeling node:', error);
        return response.status(500).send({ error: true });
    }
});

/** Renames the character name inside all messages for a character, directly in the DB. */
router.post('/tree/rename-in-content', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { avatar_url, new_name } = request.body;
        if (!avatar_url || !new_name) {
            return response.sendStatus(400);
        }

        const ownerId = String(avatar_url).replace('.png', '');

        // No-op, not a failure - an explicit flag lets the client tell this apart from a real failure.
        if (!await hasSavedChats(request.user.directories, ownerId)) {
            return response.send({ ok: true, updated: 0, noSavedChats: true });
        }

        const updated = await renameCharacterInMessages(request.user.directories, ownerId, String(new_name));
        return response.send({ ok: true, updated, noSavedChats: false });
    } catch (error) {
        console.error('Error renaming character in messages:', error);
        return response.status(500).send({ error: true });
    }
});

/** Renames one member's messages inside a group's tree, directly in the DB. */
router.post('/tree/rename-group-member', async function (request, response) {
    try {
        const { group_id, old_avatar, new_avatar, new_name } = request.body;
        if (!group_id || !old_avatar || !new_avatar || !new_name) {
            return response.sendStatus(400);
        }

        const updated = await renameGroupMemberInMessages(request.user.directories, String(group_id), String(old_avatar), String(new_avatar), String(new_name));
        return response.send({ ok: true, updated });
    } catch (error) {
        console.error('Error renaming group member in messages:', error);
        return response.status(500).send({ error: true });
    }
});

/** Lists all branches for a character in the tree DB. */
router.post('/tree/branches', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const ownerId = String(request.body.avatar_url).replace('.png', '');
        const branches = await listBranches(request.user.directories, ownerId);

        const result = branches.map(b => ({
            node_id: b.id,
            file_name: b.name,
            file_size: 0,
            message_count: b.message_count,
            last_mes: b.last_mes ?? '',
            chat_metadata: b.metadata != null && b.metadata !== '' ? JSON.parse(b.metadata) : {},
        }));

        return response.send(result);
    } catch (error) {
        console.error('Error listing tree branches:', error);
        return response.status(500).send([]);
    }
});

/**
 * Fills in the alternatives a chat load left as holes: a load ships only a window around the selected
 * alternative, since a wide fork point can carry thousands of them.
 */
router.post('/alternatives', async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) {
            return response.status(400).send({ error: 'node_id is required' });
        }

        const offset = Number.isFinite(Number(request.body.offset)) ? Number(request.body.offset) : undefined;
        const limit = Number.isFinite(Number(request.body.limit)) ? Number(request.body.limit) : undefined;

        const result = await getAlternatives(request.user.directories, nodeId, { offset, limit });
        if (!result) {
            return response.status(404).send({ error: 'Node not found' });
        }
        return response.send(result);
    } catch (error) {
        console.error('Error fetching alternatives:', error);
        return response.status(500).send({ error: true });
    }
});

/** The path from root down to a node, for bridging to a bookmark off the client's currently loaded path. */
router.post('/ancestry', async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) {
            return response.status(400).send({ error: 'node_id is required' });
        }
        const chatName = typeof request.body.chat_name === 'string' ? request.body.chat_name : null;
        const result = await getAncestorPath(request.user.directories, nodeId, chatName);
        if (!result) {
            return response.status(404).send({ error: 'Node not found' });
        }
        return response.send({ messages: result });
    } catch (error) {
        console.error('Error fetching ancestry:', error);
        return response.status(500).send({ error: true });
    }
});

/** The conversation below a node, for moving onto a different alternative's path. */
// ---------------------------------------------------------------------------
//  Per-row operations a save is made of, replacing handing the whole conversation over each time.
// ---------------------------------------------------------------------------

/**
 * Which owner an operation is against: a character by avatar, or a group by its own id (a group has no
 * avatar). No migration precondition here - these routes act on a row the client already holds, which it
 * can only hold because a load (which runs migrate-on-touch) put it there.
 */
const ownerOf = (/** @type {import('express').Request} */ request) => (request.body.group_id
    ? String(request.body.group_id)
    : String(request.body.avatar_url).replace('.png', ''));

/** The owner descriptor for an op's request: the group named by group_id, else the character named by avatar_url. */
const ownerDescriptorOfRequest = (/** @type {import('express').Request} */ request) =>
    ownerDescriptorOf({ groupId: request.body.group_id, avatar: request.body.avatar_url });

/** Edits one message's content. */
router.post('/message/edit', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const result = await editMessage(request.user.directories, ownerOf(request), nodeId, request.body.content);
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error editing message:', error);
        return response.status(500).send({ error: true });
    }
});

/** Applies one change that spans many messages as one request; refusals are reported per message. */
router.post('/message/edit-batch', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const edits = Array.isArray(request.body.edits) ? request.body.edits : null;
        if (!edits) return response.status(400).send({ error: 'edits is required' });

        const result = await editMessages(request.user.directories, ownerOf(request), edits);
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error editing messages:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Appends one or more messages after a node. `send_keys[i]` is the key the page made when the user sent
 * `messages[i]`; a send already stored under its key is answered with its node (in `already_stored` too).
 */
router.post('/message/append', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const after = String(request.body.after_node_id || '');
        if (!after) return response.status(400).send({ error: 'after_node_id is required' });

        const contents = Array.isArray(request.body.messages) ? request.body.messages : [];
        const sendKeys = Array.isArray(request.body.send_keys) ? request.body.send_keys : [];
        const result = await appendMessages(request.user.directories, ownerOf(request), after, contents, { sendKeys });

        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error appending messages:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Reads a character's card fresh off disk and returns its greetings in the message-object shape
 * {@link getOpeningAlternatives} merges against. Reads server-side rather than trusting a caller-supplied
 * array: a greeting only ever reaches disk through a confirmed `/greetings/*` op, so the stored card is
 * always the freshest copy by the time anything asks for openings.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<TreeChatMessage[]>} Empty array if the character can't be read.
 */
async function _cardGreetingsFromDisk(directories, avatar) {
    return (await _cardFromDisk(directories, avatar)).greetings;
}

/**
 * {@link _cardGreetingsFromDisk}'s greetings, plus the card's greeting texts by card position.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<{ greetings: TreeChatMessage[], texts: string[] }>} Both empty if the character can't be read.
 */
async function _cardFromDisk(directories, avatar) {
    try {
        // readCardContent(), not readCharacterData(): a greeting edit is persisted to the metadata db
        // without rewriting the PNG, so reading the file directly could show stale greetings.
        const pngStringData = await readCardContent(directories, avatar);
        if (pngStringData == null || pngStringData === '') return { greetings: [], texts: [] };
        const character = JSON.parse(pngStringData);
        const { greetings } = cardToGreetingsModel(character);
        const speaker = character?.name ?? character?.data?.name ?? '';
        const sendDate = Date.now();
        return {
            greetings: greetings
                .filter(text => typeof text === 'string' && text.length > 0)
                .map(text => ({ name: speaker, is_user: false, is_system: false, send_date: sendDate, mes: text, extra: {} })),
            texts: greetings,
        };
    } catch (error) {
        console.error(`Error reading card greetings for "${avatar}":`, error);
        return { greetings: [], texts: [] };
    }
}

/**
 * The openings a character can start on: every greeting any of its chats has ever opened from. Addressed by
 * character rather than node, since starting a chat has no node yet. An entry with no node_id is a card
 * greeting with no row yet - it gets one when someone opens a conversation on it.
 */
router.post('/openings', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const offset = Number.isFinite(Number(request.body.offset)) ? Number(request.body.offset) : undefined;
        const limit = Number.isFinite(Number(request.body.limit)) ? Number(request.body.limit) : undefined;
        const around = request.body.around && typeof request.body.around === 'object' && typeof request.body.around.mes === 'string'
            ? request.body.around
            : undefined;
        const avatar = String(request.body.avatar_url || '');
        // Group chats have no single card to read greetings off of.
        const cardGreetings = avatar ? await _cardGreetingsFromDisk(request.user.directories, avatar) : [];
        const result = await getOpeningAlternatives(request.user.directories, ownerOf(request), { offset, limit, around }, cardGreetings);
        if (!result) return response.status(404).send({ error: 'Tree storage unavailable' });
        return response.send(result);
    } catch (error) {
        console.error('Error listing openings:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Where a chat showing one of a character's card greetings should land after the card changed, from the full list
 * of its openings (see findOpeningToLandOn). Body: `shown_text` (the text the chat showed), `index` (the opening
 * index it was on) and `edits` (this page's own edits in the change, `{ from, to, index }`, at most
 * LANDING_EDITS_MAX). Answers `{ index, opening }`, `opening` null when the character has no openings.
 */
router.post('/openings/land', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        if (!avatar) return response.status(400).send({ error: 'avatar_url is required' });
        const shownText = request.body.shown_text;
        if (typeof shownText !== 'string') return response.status(400).send({ error: 'shown_text is required' });
        const index = request.body.index;
        if (!Number.isInteger(index) || index < 0) return response.status(400).send({ error: 'index must be a non-negative integer' });
        const rawEdits = request.body.edits ?? [];
        if (!Array.isArray(rawEdits) || rawEdits.length > LANDING_EDITS_MAX) return response.status(400).send({ error: `edits must be a list of at most ${LANDING_EDITS_MAX}` });
        const edits = [];
        for (const e of rawEdits) {
            if (typeof e?.from !== 'string' || typeof e?.to !== 'string') return response.status(400).send({ error: 'each edit needs from and to' });
            edits.push({ from: e.from, to: e.to, index: Number.isInteger(e.index) ? e.index : undefined });
        }
        const card = await _cardFromDisk(request.user.directories, avatar);
        const result = await findOpeningToLandOn(request.user.directories, ownerOf(request), card.greetings, card.texts, { shownText, index, edits });
        if (!result) return response.status(404).send({ error: 'Tree storage unavailable' });
        return response.send(result);
    } catch (error) {
        console.error('Error finding the opening to land on:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Records that the character's chat was switched to one of its card greetings that has no row yet, so reopening the
 * chat shows it. Body: `text` (the greeting's text) and `index` (its card position). Selecting a stored opening
 * (`/message/select`) replaces it.
 */
router.post('/openings/choose', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        if (!avatar) return response.status(400).send({ error: 'avatar_url is required' });
        const text = request.body.text;
        if (typeof text !== 'string' || text.length === 0) return response.status(400).send({ error: 'text is required' });
        const index = request.body.index;
        if (!Number.isInteger(index) || index < 0) return response.status(400).send({ error: 'index must be a non-negative integer' });
        const ok = await chooseCardOpening(request.user.directories, ownerOf(request), text, index);
        if (!ok) return response.status(404).send({ error: 'Tree storage unavailable' });
        return response.send({ ok: true });
    } catch (error) {
        console.error('Error recording the chosen opening:', error);
        return response.status(500).send({ error: true });
    }
});

/** Makes sure these openings exist for a character, creating its anchor if this is the first. */
router.post('/openings/ensure', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const contents = request.body.contents ?? request.body.content;
        if (!contents) return response.status(400).send({ error: 'content or contents is required' });

        const result = await addOpeningAlternatives(request.user.directories, ownerOf(request), contents, ownerDescriptorOfRequest(request));
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error ensuring openings:', error);
        return response.status(500).send({ error: true });
    }
});

/** Adds alternatives alongside an existing node. Idempotent, so a set can be asserted repeatedly. */
router.post('/message/alternative', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const sibling = String(request.body.sibling_node_id || '');
        if (!sibling) return response.status(400).send({ error: 'sibling_node_id is required' });

        const contents = request.body.contents ?? request.body.content;
        if (!contents) return response.status(400).send({ error: 'content or contents is required' });

        const result = await addAlternatives(request.user.directories, ownerOf(request), sibling, contents);

        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error adding alternative:', error);
        return response.status(500).send({ error: true });
    }
});

/** Ends the conversation at this node: cuts the tail without deleting it (a later select restores it). */
router.post('/message/end-path', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (request.body.end_at_anchor) {
            const ok = await endPathAtAnchor(request.user.directories, ownerOf(request), ownerDescriptorOfRequest(request));
            return response.status(ok ? 200 : 409).send({ ok, reason: ok ? undefined : 'no tree store' });
        }

        const nodeId = String(request.body.node_id || '');
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const ok = await endPathAt(request.user.directories, ownerOf(request), nodeId);
        return response.status(ok ? 200 : 409).send({ ok, reason: ok ? undefined : 'unknown node' });
    } catch (error) {
        console.error('Error ending the path:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Inserts a new node between two adjacent nodes — the mid-chain-insert primitive (a user-typed message spliced into the
 * middle of a chain, not appended at the end). A `send_key` already stored is answered with its node and `already_stored`.
 */
router.post('/message/graft', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const after = String(request.body.after_node_id || '');
        if (!after) return response.status(400).send({ error: 'after_node_id is required' });
        const before = String(request.body.before_node_id || '');
        if (!before) return response.status(400).send({ error: 'before_node_id is required' });

        const result = await graftMessage(request.user.directories, ownerOf(request), after, before, request.body.content, { sendKey: request.body.send_key });

        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error grafting message:', error);
        return response.status(500).send({ error: true });
    }
});

/** Removes one or more contiguous messages from the default path — the mid-chain-delete primitive. */
router.post('/message/degraft', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const first = String(request.body.first_node_id || '');
        if (!first) return response.status(400).send({ error: 'first_node_id is required' });
        const last = String(request.body.last_node_id || first);

        const result = await degraftRange(request.user.directories, ownerOf(request), first, last);
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error degrafting message:', error);
        return response.status(500).send({ error: true });
    }
});

/** Swaps two adjacent on-path messages — the mid-chain-reorder primitive (`messageEditMove()`'s array-slot swap was silently not persisting, since both messages keep their own node_id). */
router.post('/message/swap-adjacent', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const upper = String(request.body.upper_node_id || '');
        if (!upper) return response.status(400).send({ error: 'upper_node_id is required' });
        const lower = String(request.body.lower_node_id || '');
        if (!lower) return response.status(400).send({ error: 'lower_node_id is required' });

        const result = await swapAdjacent(request.user.directories, ownerOf(request), upper, lower);
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error swapping adjacent messages:', error);
        return response.status(500).send({ error: true });
    }
});

/** Deletes an unused alternative (swipe) outright — the mid-chain-delete-a-leaf primitive. Refused (409) if it's currently shown, has its own descendants, or is labeled — see {@link deleteAlternative}'s doc comment for why each of those is non-negotiable. */
router.post('/message/alternative/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const node = String(request.body.node_id || '');
        if (!node) return response.status(400).send({ error: 'node_id is required' });

        const result = await deleteAlternative(request.user.directories, ownerOf(request), node);
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error deleting alternative:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Selects a message: it becomes the shown alternative where it is, and with `activate` the character's chat is at
 * it. `opening` (the chat's greetings, shown but not stored yet) stores them first and selects the first
 * (applyPageWrites()); the answer's `stored` names their rows. Answers the conversation below the message, and with
 * `with_ancestry` the path down to it too.
 */
router.post('/message/select', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const directories = request.user.directories;
        let child = String(request.body.node_id || '');
        if (!child && request.body.opening) {
            const written = await applyPageWrites(response, directories, {
                ownerId: ownerOf(request), avatar: request.body.avatar_url, groupId: request.body.group_id,
                body: { node_id: null, opening: request.body.opening, page_metadata: request.body.page_metadata },
            });
            if (!written) return;
            child = storedMessagesOf(response)?.find(s => !('integrity' in s))?.node_id ?? '';
        }
        if (!child) return response.status(400).send({ error: 'node_id is required' });

        const ok = await selectDefaultChild(directories, child);
        if (!ok) {
            return response.status(409).send({ ok, reason: 'unknown node, or it has no parent' });
        }
        if (request.body.activate && request.body.avatar_url) {
            await setCharacterActiveChat(directories, request.body.avatar_url, child);
        }
        const branchName = request.body.chat_name ? String(request.body.chat_name) : null;
        const continuation = await getContinuation(directories, child, branchName);
        const ancestry = request.body.with_ancestry ? await getAncestorPath(directories, child, branchName) : undefined;
        return response.send({ ok: true, messages: continuation?.messages ?? [], ancestry, stored: storedMessagesOf(response) ?? undefined });
    } catch (error) {
        console.error('Error selecting alternative:', error);
        return response.status(500).send({ error: true });
    }
});

// ---------------------------------------------------------------------------
//  Node-addressed reads. A node id is the only thing that identifies a position - `label` is not
//  unique per owner, so looking one up by name would silently pick whichever row comes first.
// ---------------------------------------------------------------------------

/** Reads the tree at a node: everything above it, and the continuation below it. */
router.post('/at', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const result = await loadAtNode(request.user.directories, ownerOf(request), nodeId);
        if (!result) return response.status(404).send({ error: 'Node not found' });
        return response.send(result);
    } catch (error) {
        console.error('Error reading at node:', error);
        return response.status(500).send({ error: true });
    }
});

/** The bookmarks an owner has: nodes someone labelled so they could get back to them. */
router.post('/labels', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        return response.send(await listLabels(request.user.directories, ownerOf(request)));
    } catch (error) {
        console.error('Error listing labels:', error);
        return response.status(500).send([]);
    }
});

/**
 * Builds the /api/settings/save-partial-shaped 409 body for a metadata write whose `expected_integrity`
 * no longer matches the node's current `integrity` - same `result`/`error`/`conflictingKeys` convention,
 * with the single addressed node/chat standing in for save-partial's list of conflicting settings keys.
 * @param {string} id
 */
function integrityConflictResponse(id) {
    return {
        result: 'conflict',
        error: 'This metadata was changed by another session since this client last saw it.',
        conflictingKeys: [id],
    };
}

/** Replaces the metadata stored on a node. */
router.post('/node/metadata', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const expectedIntegrity = request.body.expected_integrity;
        const result = await setNodeMetadata(request.user.directories, ownerOf(request), nodeId, request.body.metadata, expectedIntegrity);
        if (!result.ok && result.reason === 'conflict') {
            return response.status(409).send(integrityConflictResponse(nodeId));
        }
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error saving node metadata:', error);
        return response.status(500).send({ error: true });
    }
});

/** Replaces a chat's metadata. */
router.post('/metadata', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const chatName = String(request.body.file_name || '');
        if (!chatName) return response.status(400).send({ error: 'file_name is required' });

        const expectedIntegrity = request.body.expected_integrity;
        const result = await setChatMetadata(request.user.directories, ownerOf(request), chatName, request.body.metadata, expectedIntegrity);
        if (!result.ok && result.reason === 'conflict') {
            return response.status(409).send(integrityConflictResponse(chatName));
        }
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error saving chat metadata:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }

    const chatName = String(request.body.file).replace(/\.jsonl$/, '');
    const exportfilename = request.body.exportfilename;

    // The group case previously never reached the tree DB path here (it only checked a non-group
    // `ownerId`, so group exports always fell through to the now-removed JSONL fallback) - resolving
    // the owning group the same way /rename and /group/get do closes that gap instead of carrying it
    // forward as a silent regression once the fallback goes away.
    const ownerId = request.body.is_group
        ? resolveGroupOwner(request.user.directories.groups, { chatId: chatName, groupId: request.body.group_id })?.id ?? null
        : String(request.body.avatar_url).replace('.png', '');

    if (ownerId == null || ownerId === '' || !await hasSavedChats(request.user.directories, ownerId)) {
        return response.status(404).json({ message: `Could not find chat to export: ${chatName}.` });
    }

    try {
        const result = await loadBranch(request.user.directories, ownerId, chatName, true);
        if (!result) {
            return response.status(404).json({ message: `Branch "${chatName}" not found in tree DB.` });
        }

        const header = { chat_metadata: result.metadata, user_name: 'unused', character_name: 'unused' };
        // message-tree-db.js's rowToMessage() always stamps a runtime `node_id` onto every TreeChatMessage
        // it returns, but that field isn't part of the `TreeChatMessage` JSDoc type itself (cross-file gap
        // in a file this pass doesn't own) - annotated locally rather than editing message-tree-db.js.
        const allData = /** @type {(typeof header | (TreeChatMessage & { node_id: string }))[]} */ ([header, ...result.messages]);

        if (request.body.format === 'jsonl') {
            const jsonl = allData.map(m => {
                const clean = /** @type {Record<string, unknown>} */ ({ ...m });
                delete clean.node_id; // Strip internal tree field from export
                return JSON.stringify(clean);
            }).join('\n');
            return response.status(200).json({
                message: `Chat saved to ${exportfilename}`,
                result: jsonl,
            });
        }

        // Plain text export
        let buffer = '';
        for (const msg of result.messages) {
            if (msg.is_system === true) continue;
            if (msg.mes != null && msg.mes !== '') {
                const name = msg.name;
                const displayText = msg.extra?.display_text;
                const text = (displayText != null && displayText !== '') ? displayText : msg.mes;
                const message = text.replace(/\r?\n/g, '\n');
                buffer += `${name}: ${message}\n\n`;
            }
        }
        return response.status(200).json({
            message: `Chat saved to ${exportfilename}`,
            result: buffer,
        });
    } catch (err) {
        console.error('Tree chat export failed:', err);
        return response.sendStatus(400);
    }
});

router.post('/group/import', async function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const chatname = humanizedDateTime();
        const pathToUpload = path.join(filedata.destination, filedata.filename);

        const useTree = await isTreeAvailable(request.user.directories);
        const group = useTree ? resolveGroupOwner(request.user.directories.groups, { groupId: request.body?.group_id }) : null;

        if (group) {
            const raw = fs.readFileSync(pathToUpload, 'utf8');
            const chatData = raw.split('\n').map(line => tryParse(line)).filter(x => x);
            if (chatData.length === 0) {
                fs.unlinkSync(pathToUpload);
                console.error('Group chat import failed: the uploaded file held no parseable lines.');
                return response.send({ error: true });
            }

            const result = await saveChatToTree(request.user.directories, group.id, chatname, chatData, true);
            if (result && 'integrity' in result) {
                fs.unlinkSync(pathToUpload);
                return response.send({ res: chatname });
            }
            // Backend unavailable (now impossible at runtime, see server-main.js's boot-time
            // verifySqliteBackend()) - fall through to the file write rather than losing the upload.
            // (chatData can't be empty here: it was already rejected above when parsed from the upload.)
        }

        const pathToNewFile = path.join(request.user.directories.groupChats, `${chatname}.jsonl`);
        fs.copyFileSync(pathToUpload, pathToNewFile);
        fs.unlinkSync(pathToUpload);
        return response.send({ res: chatname });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/import', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const format = request.body.file_type;
    const avatarUrl = (request.body.avatar_url).replace('.png', '');
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
    /** @type {string[]} */
    const fileNames = [];

    if (!request.file) {
        return response.sendStatus(400);
    }

    const directoryPath = path.join(request.user.directories.chats, avatarUrl);
    if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
        return response.sendStatus(400);
    }

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const data = fs.readFileSync(pathToUpload, 'utf8');

        const useTree = await isTreeAvailable(request.user.directories);

        /**
         * @param {string} chatText jsonl-formatted chat text (header line + one message per line)
         * @param {string} chatName
         * @returns {Promise<boolean>} true if saved to the tree, false if the caller must fall back
         * to a raw file write.
         */
        const saveImportToTree = async (chatText, chatName) => {
            if (!useTree) return false;
            const chatData = chatText.split('\n').map(line => tryParse(line)).filter(x => x);
            const result = await saveChatToTree(request.user.directories, avatarUrl, chatName, chatData, false, ownerDescriptorOf({ avatar: request.body.avatar_url }));
            return !!(result && 'integrity' in result);
        };

        if (format === 'json') {
            fs.unlinkSync(pathToUpload);
            const jsonData = JSON.parse(data);

            // jsonData is genuinely dynamic here (parsed from an untrusted uploaded file, format-sniffed
            // below), so importFunc's 3rd parameter has to be `any` to accept whichever narrower format
            // typedef each concrete import*Chat() function declares.
            /** @type {(userName: string, characterName: string, jsonData: any) => string|string[]} */
            let importFunc;

            if (jsonData.savedsettings !== undefined) { // Kobold Lite format
                importFunc = importKoboldLiteChat;
            } else if (jsonData.histories !== undefined) { // CAI Tools format
                importFunc = importCAIChat;
            } else if (Array.isArray(jsonData.data_visible)) { // oobabooga's format
                importFunc = importOobaChat;
            } else if (Array.isArray(jsonData.messages)) { // Agnai's format
                importFunc = importAgnaiChat;
            } else if (jsonData.type === 'risuChat') { // RisuAI format
                importFunc = importRisuChat;
            } else { // Unknown format
                console.error('Incorrect chat format .json');
                return response.send({ error: true });
            }

            const handleChat = async (/** @type {string} */ chat) => {
                const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
                fileNames.push(fileName);
                if (await saveImportToTree(chat, fileName.replace(/\.jsonl$/, ''))) return;
                const filePath = path.join(directoryPath, fileName);
                writeFileAtomicSync(filePath, chat, 'utf8');
            };

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                for (const c of chat) await handleChat(c);
            } else {
                await handleChat(chat);
            }

            return response.send({ res: true, fileNames });
        }

        if (format === 'jsonl') {
            let lines = data.split('\n');
            const header = lines[0];

            const jsonData = JSON.parse(header);

            if (!(jsonData.user_name !== undefined || jsonData.name !== undefined || jsonData.chat_metadata !== undefined)) {
                console.error('Incorrect chat format .jsonl');
                return response.send({ error: true });
            }

            // Do a tiny bit of work to import Chub Chat data
            // Processing the entire file is so fast that it's not worth checking if it's a Chub chat first
            let flattenedChat = data;
            try {
                // flattening is unlikely to break, but it's not worth failing to
                // import normal chats in an attempt to import a Chub chat
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                console.warn('Failed to flatten Chub Chat data: ', error);
            }

            const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
            fileNames.push(fileName);
            if (!(await saveImportToTree(flattenedChat, fileName.replace(/\.jsonl$/, '')))) {
                const filePath = path.join(directoryPath, fileName);
                if (flattenedChat !== data) {
                    writeFileAtomicSync(filePath, flattenedChat, 'utf8');
                } else {
                    fs.copyFileSync(pathToUpload, filePath);
                }
            }
            fs.unlinkSync(pathToUpload);
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/group/get', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = String(request.body.id);
        const group = resolveGroupOwner(request.user.directories.groups, { chatId: id, groupId: request.body.group_id });

        if (group) {
            const result = await loadAtNode(request.user.directories, group.id, id)
                ?? await loadBranch(request.user.directories, group.id, id);
            if (result) {
                /** @type {any} */
                const header = {
                    chat_metadata: { ...result.metadata },
                    user_name: 'unused',
                    character_name: 'unused',
                };
                return response.send([header, ...result.messages]);
            }
        }
        // Empty array, not the 404 character /get returns: getGroupChat() reads a miss as "fresh chat"
        // and seeds it from member greetings, which groups have no isNewChat flag to signal otherwise.
        // Also what a group not found at all resolves to (no group claims `id`, nothing to load).
        return response.send([]);
    } catch (error) {
        console.error(error);
        return response.send([]);
    }
});

/** Every chat a group owns, in one call, the way /tree/branches answers it for a character. */
router.post('/group/branches', async (request, response) => {
    try {
        if (!request.body || !request.body.group_id) {
            return response.sendStatus(400);
        }

        const groupId = String(request.body.group_id);
        const group = resolveGroupOwner(request.user.directories.groups, { groupId });
        if (!group) {
            return response.send([]);
        }

        const branches = await listBranches(request.user.directories, group.id);
        return response.send(branches.map(b => ({
            node_id: b.id,
            file_id: b.name,
            file_name: `${b.name}.jsonl`,
            file_size: formatBytes(0),
            chat_items: b.message_count,
            mes: (b.last_mes != null && b.last_mes !== '') ? b.last_mes : '[No messages]',
            // The branch's leaf, not its label's birthday - see branchViewSync().
            last_mes: b.last_activity,
            chat_metadata: (request.body.metadata && b.metadata != null && b.metadata !== '') ? JSON.parse(b.metadata) : undefined,
        })));
    } catch (error) {
        console.error('Error listing group branches:', error);
        return response.status(500).send([]);
    }
});

router.post('/group/info', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = String(request.body.id);
        const group = resolveGroupOwner(request.user.directories.groups, { chatId: id, groupId: request.body.group_id });

        if (group) {
            const branch = (await listBranches(request.user.directories, group.id)).find(b => b.name === id);
            if (branch) {
                return response.send({
                    match: true,
                    file_id: branch.name,
                    file_name: `${branch.name}.jsonl`,
                    file_size: formatBytes(0),
                    chat_items: branch.message_count,
                    mes: (branch.last_mes != null && branch.last_mes !== '') ? branch.last_mes : '[The chat is empty]',
                    last_mes: branch.last_activity,
                });
            }
        }

        return response.send({ match: false });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/delete', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = String(request.body.id);
        // The client drops this chat from its in-memory copy of the group's `chats` before asking, and may
        // never save that list, so the id can still be in the group file - group_id names the owner either way.
        const group = resolveGroupOwner(request.user.directories.groups, { chatId: id, groupId: request.body.group_id });
        if (!group) {
            console.error('The group chat was not deleted.');
            return response.sendStatus(400);
        }

        /** The group's chats and current chat after the delete, answered so the page needn't decide them. */
        const groupAfter = /** @type {{ chats?: string[], chat_id?: string }} */ ({});
        // Same lock as /api/groups/new-chat's read-modify-write of `chats`, which would otherwise write the id back.
        const outcome = await withGroupLock(request.user.directories, group.id, async () => {
            // A chat with no saved messages has no labelled branch, but its id is still in `chats`.
            const branchDeleted = await deleteBranch(request.user.directories, group.id, id);
            const fullGroup = /** @type {{ chats?: string[] } | null} */ (readGroupFile(request.user.directories, group.id));
            if (!fullGroup || !Array.isArray(fullGroup.chats) || !fullGroup.chats.includes(id)) {
                return branchDeleted !== false ? 'ok' : 'not_deleted';
            }
            fullGroup.chats = fullGroup.chats.filter(chatId => chatId !== id);
            // The group's current chat moves to its last remaining one ('' when none remains).
            const groupFile = /** @type {{ chats: string[], chat_id?: string }} */ (fullGroup);
            if (groupFile.chat_id === id) groupFile.chat_id = groupFile.chats[groupFile.chats.length - 1] ?? '';
            try {
                await writeGroupFile(request.user.directories, fullGroup);
            } catch (err) {
                console.error(`Could not remove deleted chat id "${id}" from group ${group.id}:`, err);
                return 'list_not_saved';
            }
            groupAfter.chats = groupFile.chats;
            groupAfter.chat_id = groupFile.chat_id ?? '';
            return 'ok';
        });

        if (outcome === 'ok') {
            return response.send({ ok: true, ...groupAfter });
        }
        if (outcome === 'list_not_saved') {
            return response.status(500).send({ error: 'The chat was deleted, but it could not be removed from the group\'s chat list. See the server console for details.' });
        }

        console.error('The group chat was not deleted.');
        return response.sendStatus(400);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Same idea as pickUniqueChatFileName(), but for group chats: uniqueness is checked against the group's
 * own `chats` id list (already loaded via resolveGroupOwner()) instead of a directory listing, since a
 * group chat id doubles as its display name in this legacy save path.
 * @param {string[]} existingIds Group's current `chats` array.
 * @param {string} baseId Desired chat id, e.g. the main chat's display name.
 * @returns {string} `baseId` unchanged if free, otherwise `<baseId> - Branch #N` for the first free N.
 */
function pickUniqueGroupChatId(existingIds, baseId) {
    const existing = new Set(Array.isArray(existingIds) ? existingIds : []);
    if (!existing.has(baseId)) {
        return baseId;
    }
    const cleanBase = String(baseId).replace(/ - Branch #\d+$/, '');
    let i = 1;
    while (existing.has(`${cleanBase} - Branch #${i}`)) i++;
    return `${cleanBase} - Branch #${i}`;
}

/**
 * Registers a chat id in the group's own persisted `chats` list, if it isn't already there. A fresh
 * branch/bookmark save (or the `unique` minting above) introduces an id the group descriptor has never
 * heard of; without this, the caller previously had to follow up with a whole separate
 * /api/groups/save-partial request just to append one string to `chats` - two requests to persist what
 * is, from the user's perspective, one action (create a branch/bookmark). `group` here is the shallow
 * `{id, chats}` view from `resolveGroupOwner()`, so the full descriptor is re-read
 * before writing back - writing the shallow view would silently drop every other group field.
 * Ordinary chat saves (the hot path - every message of an ongoing group chat) hit the early return: the
 * id was already registered when the group/chat was created, so no extra read or write happens.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{id: string, chats: string[]}} group Shallow group view already resolved by the caller.
 * @param {string} chatId The id this save is actually writing under (post `unique` minting).
 */
async function registerGroupChatIdIfNew(directories, group, chatId) {
    if (group.chats.includes(chatId)) {
        return;
    }
    // readGroupFile() (groups.js, not owned by this pass) declares its return as the bare `object` type,
    // so the full on-disk group descriptor's actual shape - including `chats` - isn't visible here; narrowed
    // locally to the one field this function reads/writes.
    await withGroupLock(directories, group.id, async () => {
        const fullGroup = /** @type {{ chats?: string[] } | null} */ (readGroupFile(directories, group.id));
        if (!fullGroup || (Array.isArray(fullGroup.chats) && fullGroup.chats.includes(chatId))) {
            return;
        }
        fullGroup.chats = Array.isArray(fullGroup.chats) ? [...fullGroup.chats, chatId] : [chatId];
        await writeGroupFile(directories, fullGroup);
    });
}

/**
 * Fills in `extra.gen_id` for character messages missing one before a group chat is written to disk.
 * Group regeneration/swipe tracking depends on every character message carrying *some* gen_id; minting
 * the fallback here means callers that hand the server a whole chat array in one request (e.g. converting
 * a solo chat to a group) don't need to fabricate one client-side. A message that already has a gen_id -
 * real prior generation data - is left untouched; only messages missing one are filled in, with a value
 * that only needs to be unique within this one save (mirrors the old client-side `Date.now() + index`).
 * @param {(ChatHeaderLike | TreeChatMessage)[]} chatData Chat array as posted to /group/save, i.e. [header, ...messages].
 */
function assignMissingGenIds(chatData) {
    const baseId = Date.now();
    for (let index = 1; index < chatData.length; index++) {
        const message = /** @type {TreeChatMessage} */ (chatData[index]);
        if (message.is_user === true || message.is_system === true) {
            continue;
        }
        if (message.extra && typeof message.extra === 'object' && message.extra.gen_id !== undefined) {
            continue;
        }
        if (!message.extra || typeof message.extra !== 'object') {
            message.extra = {};
        }
        message.extra.gen_id = baseId + index;
    }
}

router.post('/group/save', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        let id = String(request.body.id);
        const chatData = request.body.chat;

        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }

        assignMissingGenIds(chatData);

        const group = resolveGroupOwner(request.user.directories.groups, { chatId: id, groupId: request.body.group_id });
        if (!group) {
            // Refused rather than silently written to a file nothing reads once the group is tree-backed.
            console.error(`Refusing to save group chat "${id}": no group claims it.`);
            return response.status(400).send({ error: 'unknown_group' });
        }

        // A fresh branch/bookmark save asks for an id minted here (like /chats/label's unique:true)
        // instead of asserting an id the client uniquified against its own in-memory group.chats list.
        if (request.body.unique) {
            id = pickUniqueGroupChatId(group.chats, id);
        }

        const result = await saveChatToTree(request.user.directories, group.id, id, chatData, true);
        if (result && 'integrity' in result) {
            try {
                await registerGroupChatIdIfNew(request.user.directories, group, id);
            } catch (err) {
                console.error(`Could not register new chat id "${id}" on group ${group.id}:`, err);
                return response.status(500).send({ error: 'The chat was saved, but it could not be added to the group\'s chat list, so the group won\'t show it. See the server console for details.' });
            }

            return response.send({
                ok: true,
                integrity: result.integrity,
                assigned_node_ids: result.assignedNodeIds,
                chat_id: id,
            });
        }

        // Nothing to save (chatData had no messages beyond the header). Not an error - the client
        // still expects an { ok: true } response with the id it asked to save under.
        return response.send({ ok: true, chat_id: id });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;
        const page = Math.max(0, Math.floor(Number(request.body.page) || 0));
        const pageSize = Math.max(0, Math.floor(Number(request.body.page_size) || 0));

        /** @type {string[]} */
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter((/** @type {string} */ x) => x) : [];

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        if (!avatar_url && !group_id) {
            return response.send([]);
        }

        const ownerId = group_id
            ? resolveGroupOwner(request.user.directories.groups, { groupId: String(group_id) })?.id ?? null
            : String(avatar_url).replace('.png', '');

        if (ownerId == null || ownerId === '') {
            return response.send([]);
        }

        const branches = await searchBranchesByContent(request.user.directories, ownerId, fragments);
        let results = (branches ?? []).map(b => ({
            node_id: b.id,
            file_name: b.name,
            file_size: null,
            message_count: b.message_count,
            last_mes: b.leaf_send_date != null ? b.leaf_send_date : '',
            preview_message: getPreviewMessage(b.last_mes ?? undefined),
        }));

        // Also match branch names against the query (content search only covers message text)
        if (query && branches !== null) {
            const matchedNames = new Set(results.map(r => r.file_name));
            const allBranches = fragments.length === 0 ? branches
                : await searchBranchesByContent(request.user.directories, ownerId, []);

            if (allBranches) {
                for (const b of allBranches) {
                    if (!matchedNames.has(b.name) && hasTextMatch([b.name])) {
                        results.push({
                            node_id: b.id,
                            file_name: b.name,
                            file_size: null,
                            message_count: b.message_count,
                            last_mes: b.leaf_send_date != null ? b.leaf_send_date : '',
                            preview_message: getPreviewMessage(b.last_mes ?? undefined),
                        });
                    }
                }
            }
        }

        if (pageSize > 0) {
            results = results.slice(page * pageSize, (page + 1) * pageSize);
        }
        return response.send(results);
    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    try {
        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];
        const max = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER) + pinnedChats.length;

        const treeChatInfo = (/** @type {import('../message-tree-db.js').BranchView} */ branch, /** @type {boolean} */ withMetadata) => ({
            node_id: branch.id,
            file_name: `${branch.name}.jsonl`,
            ...(branch.is_group ? { group: branch.owner_id } : { avatar: `${branch.owner_id}.png` }),
            file_size: 0,
            chat_items: branch.message_count,
            mes: (branch.last_mes != null && branch.last_mes !== '') ? branch.last_mes : '[No messages]',
            last_mes: branch.last_activity,
            chat_metadata: (withMetadata && branch.metadata != null && branch.metadata !== '') ? JSON.parse(branch.metadata) : undefined,
        });

        const branches = await listRecentBranches(request.user.directories, max);

        const isPinned = (/** @type {import('../message-tree-db.js').BranchView} */ branch) => pinnedChats.some(p =>
            p.file_name === `${branch.name}.jsonl` && (branch.is_group ? p.group === branch.owner_id : p.avatar === `${branch.owner_id}.png`));
        const recentChats = branches.sort((a, b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

            return b.last_activity - a.last_activity;
        }).slice(0, max);

        const withMetadata = !!request.body.metadata;
        const chatData = recentChats.map(branch => treeChatInfo(branch, withMetadata));

        return response.send(chatData);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
