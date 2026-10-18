import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import readline from 'node:readline';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import {
    humanizedDateTime,
    tryParse,
    formatBytes,
} from '../util.js';
import { triggerAutoSave } from './settings.js';
import { readAllSettingsAsJson, readSettingsAtPaths, writeSettingsKeys } from '../settings-store.js';
import { getStringHash } from '../../public/scripts/hash-utils.js';
import { cardToGreetingsModel } from '../greeting-list.js';
import { applyPageWrites } from '../page-writes.js';
import { storedMessagesOf } from '../stored-messages.js';
import { engineStoreHere, requestStore } from '../user-stores.js';
import { chatContext, chatNamePosition, compatChatIdOf, isOwnChat, labelBaseOf, openChatNamed } from '../chat-request.js';
import { SESSION_GONE_HEADER } from '../request-session.js';
import { bookmarkCompatId, loadSync, resolveChatNameSync, sessionCompatId, storedForm, treeOfChatIdSync } from '../chat-engine.js';
import { TYPE } from '../library-engine.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';

/**
 * @param {unknown} error
 * @returns {error is { code: string }}
 */
function hasErrorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

export const CHAT_BACKUPS_PREFIX = 'chat_';

/**
 * Builds a stable filename key for a chat's backups (upstream's): non-ASCII characters become underscores, so a
 * short hash of the raw name keeps such names' keys distinct while ASCII names stay unchanged.
 * @param {string} name The name of the chat.
 * @returns {string} Sanitized filename key for the backup files.
 */
export function getBackupKey(name) {
    const sanitized = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    if (/[^\x20-\x7E]/.test(name)) {
        const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
        return `${sanitized}_${hash}`;
    }
    return sanitized;
}

/**
 * The chat an upstream chat file path names: `<user>/chats/<avatar stem>/<name>.jsonl` (a character's) or
 * `<user>/group chats/<name>.jsonl` (a group's), with the user's directories; null for any other path.
 * @param {string} filePath
 * @returns {{ directories: any, avatar: string | null, name: string } | null}
 */
function chatFileOf(filePath) {
    const full = path.resolve(filePath);
    const name = chatName(path.basename(full));
    const parent = path.dirname(full);
    /** @type {string} */
    let root;
    /** @type {string | null} */
    let avatar = null;
    if (path.basename(parent) === USER_DIRECTORY_TEMPLATE.groupChats) {
        root = path.dirname(parent);
    } else if (path.basename(path.dirname(parent)) === USER_DIRECTORY_TEMPLATE.chats) {
        root = path.dirname(path.dirname(parent));
        avatar = `${path.basename(parent)}.png`;
    } else {
        return null;
    }
    /** @type {any} */
    const directories = { root };
    for (const [k, v] of Object.entries(USER_DIRECTORY_TEMPLATE)) directories[k] = path.join(root, /** @type {string} */ (v));
    return { directories, avatar, name };
}

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

/**
 * The chat a route acts in: a group's (`group_id`) when it names one, else a character's (`avatar_url`); null when it
 * names none that exists.
 * @param {import('express').Request} request
 * @param {{ avatar_url?: unknown, group_id?: unknown }} [body]
 */
function chatOf(request, body = request.body ?? {}) {
    return chatContext(request, { avatar: body.avatar_url, group: body.group_id });
}

/**
 * A chat name as upstream's routes send it: without `.jsonl`.
 * @param {unknown} name
 */
function chatName(name) {
    return String(name ?? '').replace(/\.jsonl$/, '');
}

/**
 * A chat's list, newest first (`chatList()`), each by its compat chat id (`file_id`: a bookmark's `b<id>`, the
 * tab's own conversation's `s<UUID>.<tree>`) and its `label` (the name the user gave it, or null).
 * @param {import('../chat-request.js').ChatContext} chat
 * @param {{ withMetadata?: boolean }} [o]
 */
async function chatListOf(chat, { withMetadata = false } = {}) {
    const rows = [];
    /** @type {string | undefined} */
    let after;
    for (;;) {
        const page = await chat.store.chats.chatList({ tree: chat.tree, session: chat.session.reader().session ?? undefined, after, limit: 500, withMetadata });
        rows.push(...page.rows.map(r => ({ ...r, file_id: r.bookmark != null ? bookmarkCompatId(r.bookmark) : sessionCompatId(String(r.session), chat.tree), label: r.name ?? null })));
        if (!page.more || page.rows.length === 0) return rows;
        after = page.rows[page.rows.length - 1].position;
    }
}

/**
 * Stores a whole chat (upstream's `/save` and `/group/save`) through the request's session, at the chat `name`
 * names: the request's own conversation (its compat chat id, or its session's UUID) is the session's (made by the
 * save when it has no key yet); another bookmark (`resolveChatName()`: its `b<id>`, or a label only it has) is the
 * session's place first and becomes its current chat (a following bookmark follows the save's appends; a pinned one
 * stays); another session is what the save acts as, this tab's current chat unchanged; a name naming nothing, or any
 * name with `unique`, is a new bookmark labelled so at the chat's last message, not opened. No name: the session's
 * own conversation. Answers what `/save` sends, `file_name` the compat chat id of the chat saved.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('../chat-request.js').ChatContext} chat
 * @param {string} name
 * @param {any[]} chatData
 */
async function saveWholeChat(request, response, chat, name, chatData) {
    const { chats } = chat.store;
    let actor = chat.session.actor();
    /** @type {string | null} The label of the bookmark the save makes at its end. */
    let newBookmark = null;
    // Upstream's integrity check passes a chat file that doesn't exist yet: a save that makes its chat isn't checked.
    let force = request.body.force === true;
    const own = chat.session.reader().session;
    /** @type {string} */
    let used = name;
    const found = name === '' || name === own || request.body.unique === true ? null : await chats.resolveChatName({ tree: chat.tree, name });
    if (name !== '' && (name === own || (found !== null && await isOwnChat(chat, found)))) {
        used = '';
        if (await chats.sessionId(own ?? undefined) === null) force = true;
    } else if (name !== '') {
        if (found === null) {
            newBookmark = name;
            force = true;
        } else if ('bookmark' in found) {
            used = bookmarkCompatId(found.bookmark);
            await openChatNamed(chat, used);
        } else {
            actor = { user: actor.user, session: found.session };
            used = sessionCompatId(found.session, chat.tree);
        }
    }
    const base = Array.isArray(request.body.base) ? request.body.base : undefined;
    const saved = await chats.saveChat({ tree: chat.tree, treeSpeaker: chat.treeSpeaker, chat: chatData, actor, force, base });
    chat.session.answer(response, { moved: true });
    if ('empty' in saved) return { status: 200, body: { ok: true, file_name: used || await compatChatIdOf(chat) } };
    if (!saved.ok) return { status: 400, body: { error: saved.reason } };
    if (saved.dropped) console.warn(`[chats/save] A save of "${name}" dropped:`, JSON.stringify(saved.dropped));
    if (saved.deletes_refused) console.warn(`[chats/save] A save of "${name}" refused deletes:`, JSON.stringify(saved.deletes_refused));
    if (newBookmark !== null) {
        const at = await chats.landingOf(chat.tree, actor);
        const made = await chats.createBookmark({ tree: chat.tree, node_id: at, name: newBookmark, actor });
        if (made.ok) used = bookmarkCompatId(made.bookmark);
    }
    return {
        status: 200,
        body: {
            ok: true,
            integrity: saved.integrity,
            assigned_node_ids: saved.assigned_node_ids,
            file_name: used || await compatChatIdOf(chat),
            ...(saved.dropped ? { dropped: saved.dropped } : {}),
            ...(saved.deletes_refused ? { deletes_refused: saved.deletes_refused } : {}),
        },
    };
}

/**
 * Upstream's save of a whole chat to its file, on the engine: the chat the path names (`chatFileOf()`), saved as
 * `/save` saves it, by `handle` with no tab. Throws when the integrity check fails (unless `skipIntegrityCheck`), the
 * path names no chat this user has, or the save fails. Chats aren't files here, so nothing is written to
 * `backupDirectory`.
 * @param {Array} chatData The chat array to save.
 * @param {string} filePath Target file path for the data.
 * @param {boolean} skipIntegrityCheck
 * @param {string} handle The user's handle.
 * @param {string} [_cardName]
 * @param {string} [_backupDirectory]
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, _cardName, _backupDirectory) {
    const file = chatFileOf(filePath);
    if (!file) throw new Error(`Not a chat file path: "${filePath}"`);
    /** @type {any} */
    const request = { user: { directories: file.directories, profile: { handle } }, body: { force: skipIntegrityCheck === true }, headers: {}, get: () => undefined };
    const chat = file.avatar !== null ? await chatContext(request, { avatar: file.avatar }) : await groupChatOf(request, file.name);
    if (!chat) throw new Error(`No chat to save at "${filePath}"`);
    /** @type {any} */
    const response = { setHeader() {}, headersSent: false };
    const { status, body } = await saveWholeChat(request, response, chat, file.name, chatData);
    if (status === 400 && body.error === 'integrity') {
        throw new Error(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatData[0]?.chat_metadata?.integrity}".`);
    }
    if (status !== 200) throw new Error(`The chat at "${filePath}" could not be saved: ${body.error}`);
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const chatData = request.body.chat;
        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
        const chat = await chatOf(request, { avatar_url: request.body.avatar_url });
        if (!chat) return response.status(404).send({ error: 'not_found' });
        const { status, body } = await saveWholeChat(request, response, chat, chatName(request.body.file_name), chatData);
        return response.status(status).send(body);
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * A chat as upstream's `/get` answers it: `[header, ...messages]`, the header's `chat_metadata` the state at its
 * position (with the request's session's `integrity`).
 * @param {import('../chat-request.js').ChatContext} chat
 * @param {string | null} at
 */
async function chatArray(chat, at) {
    const loaded = await chat.store.chats.load({ tree: chat.tree, at, session: chat.session.reader().session });
    if (!loaded) return null;
    return [{ chat_metadata: { ...loaded.metadata }, user_name: 'unused', character_name: 'unused' }, ...loaded.messages];
}

/**
 * Where a chat identifier is in a tree, read on this thread: as `chatNamePosition()` (`resolveChatNameSync()`);
 * undefined when it names nothing there.
 * @param {any} store The binding's `Store`.
 * @param {bigint} tree
 * @param {string} name
 * @returns {string | null | undefined}
 */
function chatNamePositionSync(store, tree, name) {
    const outside = (/** @type {bigint | null} */ at) => {
        if (at === null) return null;
        const [m] = store.chatReadSync('messages', { ids: [at] });
        return m?.oldKey ?? String(at);
    };
    const found = resolveChatNameSync(store, tree, name);
    if (found === null) return undefined;
    if ('bookmark' in found) {
        const [b] = store.chatReadSync('bookmarks', { ids: [found.bookmark] });
        return b ? outside(b.at) : undefined;
    }
    // An `s<UUID>.<tree>` names that session's position there, else where the tree lands.
    const where = found.session === null ? null : store.chatReadSync('sessionInTree', { session: found.session, tree });
    if (!where && 'derived' in found) return outside(store.chatReadSync('landing', { tree, ...(found.session === null ? {} : { session: found.session }) }));
    return where ? outside(where.at) : undefined;
}

/**
 * The group tree a group chat id names, read on this thread: as `groupOfChat()`.
 * @param {any} store The binding's `Store`.
 * @param {string} name
 * @returns {bigint | null}
 */
function groupTreeOfChatSync(store, name) {
    const tree = treeOfChatIdSync(store, name);
    if (tree === null) return null;
    const [e] = store.libraryEntitiesSync([tree], { fields: [], lists: [] });
    return e?.type === TYPE.group ? tree : null;
}

/**
 * Upstream's read of a chat file, on the engine (synchronous, as upstream's): the chat the path names
 * (`chatFileOf()`) as `/get` answers it, `[header, ...messages]`; [] when it names no chat.
 * @param {string} chatFilePath The full chat file path.
 * @returns {Array}
 */
export function getChatData(chatFilePath) {
    const file = chatFileOf(chatFilePath);
    const missing = () => {
        console.warn(`File not found: ${chatFilePath}. The chat does not exist or is empty.`);
        return [];
    };
    if (!file) return missing();
    const store = engineStoreHere(file.directories);
    /** @type {bigint | null | undefined} */
    let tree;
    if (file.avatar !== null) [tree] = store.libraryIdsSync([[TYPE.character, file.avatar]]);
    else tree = groupTreeOfChatSync(store, file.name);
    if (tree === null || tree === undefined) return missing();
    const at = chatNamePositionSync(store, tree, file.name);
    if (at === undefined) return missing();
    // Upstream reads the chat file: every alternative's text.
    const loaded = loadSync(store, { tree, at, full: true });
    if (!loaded) return missing();
    return [{ chat_metadata: { ...loaded.metadata }, user_name: 'unused', character_name: 'unused' }, ...loaded.messages];
}

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const name = chatName(request.body.file_name);
        // No file_name: an empty chat, as upstream answers it.
        if (!name) return response.send({});
        const chat = await chatOf(request, { avatar_url: request.body.avatar_url });
        const at = chat ? await chatNamePosition(chat, name) : undefined;
        const answer = chat && at !== undefined ? await chatArray(chat, at) : null;
        // A 404 (rather than {}) lets the client tell a stale name from a new, unsaved chat.
        if (!answer) return response.status(404).send({ error: 'not_found' });
        return response.send(answer);
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
 * A card's greetings in the message shape the openings merge against, and its greeting texts by card position;
 * both empty when the character can't be read.
 * @param {import('../user-stores.js').UserStore} store
 * @param {string} avatar
 * @returns {Promise<{ greetings: Record<string, any>[], texts: string[] }>}
 */
async function cardGreetingsOf(store, avatar) {
    try {
        const [character] = /** @type {any[]} */ (await store.lib.cards([avatar]));
        if (!character) return { greetings: [], texts: [] };
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
 * A card's openings as the page draws them: the first window (`openings`, as /openings answers an empty body) and,
 * when the card has greetings with no row, all of those (`card_openings`).
 * @param {import('../chat-request.js').ChatContext} chat
 * @param {string} avatar
 */
async function openingsForPage(chat, avatar) {
    const cardGreetings = (await cardGreetingsOf(chat.store, avatar)).greetings;
    const actor = chat.session.reader();
    const openings = await chat.store.chats.openingAlternatives({ tree: chat.tree, actor, cardGreetings });
    const cardOnly = openings.total - openings.stored;
    const cardOpenings = cardOnly > 0
        ? await chat.store.chats.openingAlternatives({ tree: chat.tree, actor, range: { offset: openings.stored, limit: cardOnly }, cardGreetings })
        : null;
    return { openings, card_openings: cardOpenings };
}

/**
 * What `/open` answers: the conversation a character or group opens on through the request's session, and
 * everything the screen draws. `chat` (a chat name) opens that chat, and with `make_current` the session moves
 * there; else the session's own place in the tree (where it lands); `fresh` (a character): no conversation, only
 * the card's greetings. Records which character or group was opened last.
 *
 * Answers `{ chat, label_base, chat_metadata, messages, openings, card_openings, stored_sends, active_character,
 * active_group, settings_hash? }`: `chat` is upstream's identifier for the open chat (`compatChatIdOf()`), `label_base`
 * what its suggested bookmark names start from (`labelBaseOf()`), `messages` as /get answers
 * them after the header; `openings`/`card_openings` for a character only (null for a group); for a group also
 * `chats` and `date_last_chat`. 404 when the character or group doesn't exist.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {{ avatar_url?: unknown, group_id?: unknown, chat?: unknown, make_current?: unknown, fresh?: unknown, send_keys?: unknown }} body
 * @returns {Promise<{ status: number, answer?: object }>}
 */
async function openChatAnswer(request, response, body) {
    const chat = await chatOf(request, body);
    if (!chat) return { status: body.group_id || body.avatar_url ? 404 : 400 };
    const { chats } = chat.store;
    const requested = typeof body.chat === 'string' && body.chat !== '' ? chatName(body.chat) : null;
    const fresh = body.fresh === true && !body.group_id;
    /** @type {string | null | undefined} */
    let at = requested === null ? undefined : await chatNamePosition(chat, requested);
    if (at !== undefined && body.make_current === true && requested !== null) {
        await openChatNamed(chat, requested);
        chat.session.answer(response, { moved: true });
    }
    if (at === undefined) at = fresh ? null : await chats.landingOf(chat.tree, chat.session.reader());
    const loaded = at === null ? null : await chats.load({ tree: chat.tree, at, session: chat.session.reader().session });
    const metadata = loaded?.metadata ?? await chats.metadata(chat.tree, null, chat.session.reader().session);
    const common = {
        chat: await compatChatIdOf(chat),
        label_base: await labelBaseOf(chat),
        chat_metadata: { ...metadata },
        messages: loaded?.messages ?? [],
        stored_sends: await chats.storedSendKeys(chat.tree, body.send_keys),
    };
    if (body.group_id) {
        const groupId = String(body.group_id);
        const stats = await chat.store.lib.chatStats([chat.tree]);
        return {
            status: 200,
            answer: {
                ...common,
                openings: null,
                card_openings: null,
                chats: (await chatListOf(chat)).map(r => r.file_id),
                date_last_chat: stats.get(chat.tree)?.date_last_chat ?? 0,
                ...recordLastOpened(request, { character: null, group: groupId }),
            },
        };
    }
    const avatar = String(body.avatar_url);
    return {
        status: 200,
        answer: {
            ...common,
            ...await openingsForPage(chat, avatar),
            ...recordLastOpened(request, { character: avatar, group: null }),
        },
    };
}

router.post('/open', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { status, answer } = await openChatAnswer(request, response, request.body);
        return answer ? response.send(answer) : response.sendStatus(status);
    } catch (error) {
        console.error('Error opening a chat:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Bookmarks a message: a bookmark named `label` at `node_id`; no `label` suggests one (a branch's, `branchLabel()`). A
 * greeting shown without a row (`opening`) is stored first, as /message/select stores it. For a group the answer
 * carries its chat list (`chats`). With `open`, the bookmark is opened as /open opens a chat (`make_current`),
 * answered as `opened`. `also_node_id` is accepted and ignored.
 */
router.post('/bookmark', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const chat = await chatOf(request);
        if (!chat) return response.sendStatus(404);
        const given = typeof request.body.label === 'string' ? request.body.label.trim() : '';
        const label = given || await branchLabel(chat);

        let nodeId = String(request.body.node_id || '');
        if (!nodeId && request.body.opening) {
            const written = await applyPageWrites(response, chat, { node_id: null, opening: request.body.opening, page_metadata: request.body.page_metadata });
            if (!written) return;
            nodeId = storedMessagesOf(response)?.find(s => !('integrity' in s))?.node_id ?? '';
        }
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const made = await chat.store.chats.createBookmark({ tree: chat.tree, node_id: nodeId, name: label, actor: chat.session.actor() });
        if (!made.ok || made.name === null) return response.status(409).send({ ok: false, reason: made.ok ? 'no name' : made.reason });
        const chats = request.body.group_id ? (await chatListOf(chat)).map(r => r.file_id) : undefined;
        const opened = request.body.open === true
            ? (await openChatAnswer(request, response, { avatar_url: request.body.avatar_url, group_id: request.body.group_id, chat: bookmarkCompatId(made.bookmark), make_current: true, send_keys: request.body.send_keys })).answer
            : undefined;
        chat.session.answer(response, { moved: !!nodeId });
        // `id` is the bookmark's compat chat id (what upstream code passes back as the chat's name); `label` its label.
        return response.send({ ok: true, node_id: nodeId, id: bookmarkCompatId(made.bookmark), label: made.name, chats, opened, stored: storedMessagesOf(response) ?? undefined });
    } catch (error) {
        console.error('Error bookmarking a message:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * A branch's suggested label (upstream's `createBranch()` naming): the chat's label base with any branch suffix taken
 * off, then ` - Branch #<n>`, the lowest n from 1 no bookmark of the tree is labelled.
 * @param {import('../chat-request.js').ChatContext} chat
 */
async function branchLabel(chat) {
    const base = (await labelBaseOf(chat)).replace(/ - Branch #\d+$/, '').replace(/^Branch #\d+ - /, '');
    for (let i = 1; ; i++) {
        const name = `${base} - Branch #${i}`;
        if ((await chat.store.chats.store.chatRead('bookmarksNamed', { tree: chat.tree, name })).length === 0) return name;
    }
}

/**
 * The group a chat id names when the request names no group (upstream's group routes send the chat id they were
 * given): a bookmark's `b<id>`, an `s<UUID>.<tree>`, or a session's UUID; a bare label names none.
 * @param {import('express').Request} request
 * @param {string} name
 * @returns {Promise<string | null>} The group's id.
 */
async function groupOfChat(request, name) {
    const store = await requestStore(request);
    const tree = await store.chats.treeOfChatId(name);
    if (tree === null) return null;
    const [key] = await store.lib.store.libraryKeys([tree]);
    return key?.type === TYPE.group ? key.key : null;
}

/**
 * The chat a group route names: by `group_id`, else the group that has a chat of that name.
 * @param {import('express').Request} request
 * @param {string} name
 */
async function groupChatOf(request, name) {
    const groupId = request.body.group_id ? String(request.body.group_id) : await groupOfChat(request, name);
    return groupId === null ? null : chatContext(request, { group: groupId });
}

/**
 * Relabels a chat: the bookmark or session the identifier names (`resolveChatName()`), the new label as given.
 * Answers `{ ok, sanitizedFileName, label }`: its compat chat id, unchanged by the relabel, and the label.
 */
router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }
        const oldName = chatName(request.body.original_file);
        const newName = chatName(request.body.renamed_file);
        const chat = request.body.is_group ? await groupChatOf(request, oldName) : await chatOf(request, { avatar_url: request.body.avatar_url });
        if (!chat) return response.status(400).send({ error: true });
        const { chats } = chat.store;
        const found = await chats.resolveChatName({ tree: chat.tree, name: oldName });
        if (found === null) return response.status(400).send({ error: true });
        const renamed = 'bookmark' in found
            ? await chats.changeBookmark({ tree: chat.tree, bookmark: String(found.bookmark), change: { name: newName } })
            : await chats.nameSession({ session: found.session, name: newName, actor: chat.session.actor() });
        if (!renamed.ok) return response.status(400).send({ error: true });
        // A label changes, not the chat: upstream code goes on with the name it is answered, the same compat id.
        const id = 'bookmark' in found ? bookmarkCompatId(found.bookmark) : 'derived' in found ? sessionCompatId(found.session, chat.tree) : found.session;
        return response.send({ ok: true, sanitizedFileName: id, label: newName });
    } catch (error) {
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Deletes a chat by name (answer 3 of the cut): a bookmark goes (its messages stay); a session goes, and a tab on it
 * is told and lands through the cascade. Answers `{ ok, opened? }`, `opened` (with `open`) the character's chat as
 * /open opens it after.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('../chat-request.js').ChatContext} chat
 * @param {string} name
 * @returns {Promise<boolean>} Whether a chat of that name was deleted.
 */
async function deleteChatNamed(request, response, chat, name) {
    const { chats } = chat.store;
    const found = await chats.resolveChatName({ tree: chat.tree, name });
    if (found === null) return false;
    if ('bookmark' in found) {
        const deleted = await chats.changeBookmark({ tree: chat.tree, bookmark: String(found.bookmark), change: { delete: true } });
        return deleted.ok;
    }
    await chats.deleteSession(found.session);
    if (chat.session.reader().session === found.session) response.setHeader(SESSION_GONE_HEADER, '1');
    return true;
}

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const chat = await chatOf(request, { avatar_url: request.body.avatar_url });
        if (!chat || !await deleteChatNamed(request, response, chat, chatName(request.body.chatfile))) {
            return response.sendStatus(400);
        }
        const opened = request.body.open === true
            ? (await openChatAnswer(request, response, { avatar_url: request.body.avatar_url, send_keys: request.body.send_keys })).answer
            : undefined;
        return response.send({ ok: true, opened });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Starts a new chat through the request's session (answer 7 of the cut). A character's: `chat` '' is a new chat on
 * its first greeting, a stored greeting's id moves the session to that opening. A group's: the session goes to its
 * root, the members' greetings shown provisionally; answered with its `chat_id` and `chats` and `opened` (as /open
 * answers). `replace` deletes the bookmark of that name, named in `deleted`.
 */
router.post('/new', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const chat = await chatOf(request);
        if (!chat) return response.sendStatus(request.body.group_id || request.body.avatar_url ? 404 : 400);
        const { chats } = chat.store;
        const actor = chat.session.actor();
        const replace = typeof request.body.replace === 'string' && request.body.replace !== '' ? request.body.replace : null;
        /** @type {string[]} */
        const deleted = [];
        if (replace !== null) {
            const found = await chats.resolveChatName({ tree: chat.tree, name: replace });
            if (found !== null && 'bookmark' in found && (await chats.changeBookmark({ tree: chat.tree, bookmark: String(found.bookmark), change: { delete: true } })).ok) {
                deleted.push(replace);
            }
        }
        if (request.body.group_id) {
            await chats.newChat({ tree: chat.tree, actor, group: true });
            await chats.setCurrentChat({ tree: chat.tree, bookmark: null, actor });
            chat.session.answer(response, { moved: true });
            const opened = (await openChatAnswer(request, response, { group_id: request.body.group_id, send_keys: request.body.send_keys })).answer;
            return response.send({ ok: true, chat_id: await compatChatIdOf(chat), chats: (await chatListOf(chat)).map(r => r.file_id), deleted, opened });
        }
        const opening = typeof request.body.chat === 'string' && request.body.chat !== '' ? request.body.chat : null;
        if (opening === null) await chats.newChat({ tree: chat.tree, actor });
        else await chats.goTo({ tree: chat.tree, node_id: opening, actor });
        await chats.setCurrentChat({ tree: chat.tree, bookmark: null, actor });
        chat.session.answer(response, { moved: true });
        return response.send({ ok: true, deleted, chat: await compatChatIdOf(chat), label_base: await labelBaseOf(chat) });
    } catch (error) {
        console.error('Error starting a new chat:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * A bookmark named `branch_name` at `node_id` (the chat's metadata is the state there, nothing is copied), opened as
 * upstream opens the fork: the session goes there and it is the current chat. Answers `chat` and `label_base` too.
 */
router.post('/fork', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { node_id, branch_name } = request.body;
        if (!node_id || !branch_name) {
            return response.sendStatus(400);
        }
        const chat = await chatOf(request);
        if (!chat) return response.sendStatus(400);
        const made = await chat.store.chats.createBookmark({ tree: chat.tree, node_id: String(node_id), name: String(branch_name), actor: chat.session.actor() });
        if (made.ok) {
            const id = bookmarkCompatId(made.bookmark);
            await openChatNamed(chat, id);
            chat.session.answer(response, { moved: true });
            return response.send({ ok: true, id, name: made.name, chat: id, label_base: await labelBaseOf(chat) });
        }
        return response.status(400).send({ error: 'Fork failed — message node not found.' });
    } catch (error) {
        console.error('Error creating fork:', error);
        return response.status(500).send({ error: true });
    }
});

/** One member of a group renamed (a new avatar and name) in the group's messages. */
router.post('/tree/rename-group-member', async function (request, response) {
    try {
        const { group_id, old_avatar, new_avatar, new_name } = request.body;
        if (!group_id || !old_avatar || !new_avatar || !new_name) {
            return response.sendStatus(400);
        }
        const chat = await chatContext(request, { group: String(group_id) });
        if (!chat) return response.sendStatus(404);
        const updated = await chat.store.chats.renameMemberInMessages({ tree: chat.tree, oldAvatar: String(old_avatar), newAvatar: String(new_avatar), newName: String(new_name) });
        return response.send({ ok: true, updated });
    } catch (error) {
        console.error('Error renaming group member in messages:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * The chat a message is in, through the request's session.
 * @param {import('express').Request} request
 * @param {string} nodeId
 */
async function chatOfMessage(request, nodeId) {
    const store = await requestStore(request);
    const [id] = await store.chats.messageIds([nodeId]);
    const s = id === null ? undefined : (await store.chats.stored([id])).get(id);
    if (!s) return null;
    const [key] = await store.lib.store.libraryKeys([s.owner]);
    if (!key) return null;
    return chatContext(request, key.type === TYPE.group ? { group: key.key } : { avatar: key.key });
}

/** The alternatives at a message, a window of them (`offset`, `limit`). */
router.post('/alternatives', async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) {
            return response.status(400).send({ error: 'node_id is required' });
        }
        const offset = Number.isFinite(Number(request.body.offset)) ? Number(request.body.offset) : undefined;
        const limit = Number.isFinite(Number(request.body.limit)) ? Number(request.body.limit) : undefined;
        const store = await requestStore(request);
        const result = await store.chats.alternatives({ node_id: nodeId, offset, limit });
        if (!result) {
            return response.status(404).send({ error: 'Node not found' });
        }
        return response.send(result);
    } catch (error) {
        console.error('Error fetching alternatives:', error);
        return response.status(500).send({ error: true });
    }
});

/** The path from the root down to a message. */
router.post('/ancestry', async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) {
            return response.status(400).send({ error: 'node_id is required' });
        }
        const chat = await chatOfMessage(request, nodeId);
        const loaded = chat ? await chat.store.chats.load({ tree: chat.tree, at: nodeId, session: chat.session.reader().session }) : null;
        if (!loaded) {
            return response.status(404).send({ error: 'Node not found' });
        }
        return response.send({ messages: loaded.messages });
    } catch (error) {
        console.error('Error fetching ancestry:', error);
        return response.status(500).send({ error: true });
    }
});

/** Edits one message's content. */
router.post('/message/edit', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });
        const chat = await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        const result = await chat.store.chats.editMessages({ tree: chat.tree, treeSpeaker: chat.treeSpeaker, edits: [{ node_id: nodeId, content: request.body.content }], actor: chat.session.actor() });
        const refused = result.refused[0];
        return refused ? response.status(409).send({ ok: false, ...refused }) : response.send({ ok: true });
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
        const chat = await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        const result = await chat.store.chats.editMessages({ tree: chat.tree, treeSpeaker: chat.treeSpeaker, edits, actor: chat.session.actor() });
        const ok = result.refused.length === 0;
        return response.status(ok ? 200 : 409).send({ ...result, ok });
    } catch (error) {
        console.error('Error editing messages:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Appends one or more messages after a message, through the request's session (it moves to the last). `send_keys[i]`
 * is the key the page made when the user sent `messages[i]`; a send already stored under its key is answered with
 * its message (in `already_stored` too).
 */
router.post('/message/append', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const after = String(request.body.after_node_id || '');
        if (!after) return response.status(400).send({ error: 'after_node_id is required' });
        const chat = await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        const contents = (Array.isArray(request.body.messages) ? request.body.messages : []).map(storedForm);
        const sendKeys = Array.isArray(request.body.send_keys) ? request.body.send_keys : [];
        const result = await chat.store.chats.appendMessages({ tree: chat.tree, treeSpeaker: chat.treeSpeaker, after, contents, sendKeys, actor: chat.session.actor() });
        chat.session.answer(response, { moved: result.ok });
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error appending messages:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * The openings a character or group can start on: its stored openings, then the card's greetings with no row
 * (`node_id` null), windowed by `offset`, `limit` or `around`.
 */
router.post('/openings', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const offset = Number.isFinite(Number(request.body.offset)) ? Number(request.body.offset) : undefined;
        const limit = Number.isFinite(Number(request.body.limit)) ? Number(request.body.limit) : undefined;
        const around = request.body.around && typeof request.body.around === 'object' && typeof request.body.around.mes === 'string'
            ? request.body.around
            : undefined;
        const chat = await chatOf(request);
        if (!chat) return response.status(404).send({ error: 'unknown chat' });
        const avatar = request.body.group_id ? '' : String(request.body.avatar_url || '');
        // A group has no card to read greetings off of.
        const cardGreetings = avatar ? (await cardGreetingsOf(chat.store, avatar)).greetings : [];
        return response.send(await chat.store.chats.openingAlternatives({ tree: chat.tree, actor: chat.session.reader(), range: { offset, limit, around }, cardGreetings }));
    } catch (error) {
        console.error('Error listing openings:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Where a chat showing one of a character's card greetings should land after the card changed. Body: `shown_text`
 * (the text the chat showed), `index` (the opening index it was on) and `edits` (every greeting whose text the change
 * edited, `{ from, to, index }`: a card has any number of greetings, so the list has no cap but the body's size).
 * Answers `{ index, opening }`, `opening` null when the character has no openings.
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
        if (!Array.isArray(rawEdits)) return response.status(400).send({ error: 'edits must be a list' });
        const edits = [];
        for (const e of rawEdits) {
            if (typeof e?.from !== 'string' || typeof e?.to !== 'string') return response.status(400).send({ error: 'each edit needs from and to' });
            edits.push({ from: e.from, to: e.to, index: Number.isInteger(e.index) ? e.index : undefined });
        }
        const chat = await chatOf(request, { avatar_url: avatar });
        if (!chat) return response.status(404).send({ error: 'unknown chat' });
        const card = await cardGreetingsOf(chat.store, avatar);
        return response.send(await chat.store.chats.openingToLandOn({ tree: chat.tree, cardGreetings: card.greetings, cardTexts: card.texts, request: { shownText, index, edits } }));
    } catch (error) {
        console.error('Error finding the opening to land on:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * The request's session chooses one of the character's card greetings that has no row: a new chat on it, its text
 * the card's at that position until a reply stores it. Body: `index` (its card position); `text` accepted.
 */
router.post('/openings/choose', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const avatar = String(request.body.avatar_url || '');
        if (!avatar) return response.status(400).send({ error: 'avatar_url is required' });
        const index = request.body.index;
        if (!Number.isInteger(index) || index < 0) return response.status(400).send({ error: 'index must be a non-negative integer' });
        const chat = await chatOf(request, { avatar_url: avatar });
        if (!chat) return response.status(404).send({ error: 'unknown chat' });
        await chat.store.chats.chooseCardGreeting({ tree: chat.tree, index, actor: chat.session.actor() });
        chat.session.answer(response, { moved: true });
        return response.send({ ok: true });
    } catch (error) {
        console.error('Error recording the chosen opening:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Adds alternatives beside a message, shown to no one: each another reply of its parent (another opening, for an
 * opening). One with a stored reply's speaker and text is that reply. Answers `{ ok, node_ids }`.
 */
router.post('/message/alternative', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const sibling = String(request.body.sibling_node_id || '');
        if (!sibling) return response.status(400).send({ error: 'sibling_node_id is required' });
        const given = request.body.contents ?? request.body.content;
        if (!given) return response.status(400).send({ error: 'content or contents is required' });
        const contents = (Array.isArray(given) ? given : [given]).map(storedForm);
        const chat = await chatOf(request);
        const s = chat ? await chat.store.chats.messageOf(chat.tree, sibling) : null;
        if (!chat || !s) return response.status(409).send({ ok: false, reason: 'unknown node' });
        const { chats } = chat.store;
        const actor = { user: chat.session.actor().user };
        if (s.parent === null) {
            const added = await chats.addOpenings({ tree: chat.tree, treeSpeaker: chat.treeSpeaker, contents, actor });
            return response.send(added);
        }
        const [parent] = await chats.externalIds([s.parent]);
        const nodeIds = [];
        for (const content of contents) {
            const added = await chats.appendMessages({ tree: chat.tree, treeSpeaker: chat.treeSpeaker, after: parent, contents: [content], actor });
            if (!added.ok) return response.status(409).send(added);
            nodeIds.push(added.node_ids[0]);
        }
        return response.send({ ok: true, node_ids: nodeIds });
    } catch (error) {
        console.error('Error adding alternative:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Inserts a new message between two adjacent messages (a message spliced into the middle of a chain). A `send_key`
 * already stored is answered with its message and `already_stored`.
 */
router.post('/message/graft', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const after = String(request.body.after_node_id || '');
        if (!after) return response.status(400).send({ error: 'after_node_id is required' });
        const before = String(request.body.before_node_id || '');
        if (!before) return response.status(400).send({ error: 'before_node_id is required' });
        const chat = await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        const result = await chat.store.chats.graftMessage({
            tree: chat.tree, treeSpeaker: chat.treeSpeaker, after, before, content: storedForm(request.body.content),
            sendKey: typeof request.body.send_key === 'string' ? request.body.send_key : null, actor: chat.session.actor(),
        });
        chat.session.answer(response, { moved: result.ok });
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error grafting message:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Cuts `first_node_id` .. `last_node_id` out of the request's session's path (upstream's delete of messages: they
 * leave this chat; other branches keep what they share). `preview` answers what else it would drop (bookmarks,
 * state changes), writing nothing; `confirm` names exactly those, else it is refused with them. Applied, `copied`
 * maps each message the path now shows a copy of (a later message other branches share) to its copy.
 */
router.post('/message/cut', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const first = String(request.body.first_node_id || '');
        if (!first) return response.status(400).send({ error: 'first_node_id is required' });
        const last = String(request.body.last_node_id || first);
        const chat = await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        const preview = request.body.preview === true;
        const result = await chat.store.chats.cutFromPath({ tree: chat.tree, first, last, actor: chat.session.actor(), preview, confirm: request.body.confirm });
        chat.session.answer(response, { moved: result.ok && !preview });
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error cutting messages:', error);
        return response.status(500).send({ error: true });
    }
});

/** Swaps two adjacent messages of the path. */
router.post('/message/swap-adjacent', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const upper = String(request.body.upper_node_id || '');
        if (!upper) return response.status(400).send({ error: 'upper_node_id is required' });
        const lower = String(request.body.lower_node_id || '');
        if (!lower) return response.status(400).send({ error: 'lower_node_id is required' });
        const chat = await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        const result = await chat.store.chats.swapAdjacent({ tree: chat.tree, upper, lower, actor: chat.session.actor() });
        chat.session.answer(response, { moved: result.ok });
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error swapping adjacent messages:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Deletes a swipe and everything below it. `preview` answers what else it would drop (bookmarks, state changes),
 * writing nothing; `confirm` names exactly those (as the preview did), else it is refused with them.
 */
router.post('/message/alternative/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const node = String(request.body.node_id || '');
        if (!node) return response.status(400).send({ error: 'node_id is required' });
        const chat = await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        const result = await chat.store.chats.deleteSubtree({
            tree: chat.tree, node_id: node, actor: chat.session.actor(),
            preview: request.body.preview === true, confirm: request.body.confirm,
        });
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error deleting alternative:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Swipes to a message: it becomes the request's session's choice where it is, and the session goes down that
 * branch along the fork choices to its end. `opening` (the chat's greetings, shown but not stored yet) stores them
 * first and selects the first (applyPageWrites()); `stored` names their rows. Answers the conversation below the
 * message (`messages`, down to where the session now is), and with `with_ancestry` the path down to it too, and
 * `chat_metadata`, the state where the session now is.
 */
router.post('/message/select', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        // A message names its tree; the owner fields name it only for the opening, which has no id yet.
        const named = String(request.body.node_id || '');
        const chat = named ? await chatOfMessage(request, named) : await chatOf(request);
        if (!chat) return response.status(409).send({ ok: false, reason: 'unknown chat' });
        let child = String(request.body.node_id || '');
        if (!child && request.body.opening) {
            const written = await applyPageWrites(response, chat, { node_id: null, opening: request.body.opening, page_metadata: request.body.page_metadata });
            if (!written) return;
            child = storedMessagesOf(response)?.find(s => !('integrity' in s))?.node_id ?? '';
        }
        if (!child) return response.status(400).send({ error: 'node_id is required' });
        const { chats } = chat.store;
        const actor = chat.session.actor();
        if (!await chats.select({ tree: chat.tree, node_id: child, actor })) {
            return response.status(409).send({ ok: false, reason: 'unknown node' });
        }
        chat.session.answer(response, { moved: true });
        const loaded = await chats.load({ tree: chat.tree, at: await chats.landingOf(chat.tree, actor), session: actor.session });
        const messages = loaded?.messages ?? [];
        const at = messages.findIndex(m => m.node_id === child);
        return response.send({
            ok: true,
            messages: at === -1 ? [] : messages.slice(at + 1),
            ancestry: request.body.with_ancestry ? (at === -1 ? [] : messages.slice(0, at + 1)) : undefined,
            chat_metadata: loaded?.metadata,
            stored: storedMessagesOf(response) ?? undefined,
        });
    } catch (error) {
        console.error('Error selecting alternative:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Changes the chat's state where the request's session is (the page's `changedMetadata()`): `{ set, unset,
 * variables? }`, each key or variable written only when its value differs. Answers `{ ok }`; a failure `{ ok: false,
 * reason, state }` with the state there as stored.
 */
router.post('/metadata', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const chat = await chatOf(request);
        if (!chat) return response.status(404).send({ ok: false, reason: 'unknown chat' });
        const { chats } = chat.store;
        const actor = chat.session.actor();
        const at = await chats.landingOf(chat.tree, actor);
        const body = request.body;
        const set = body.set && typeof body.set === 'object' && !Array.isArray(body.set) ? body.set : {};
        const unset = Array.isArray(body.unset) ? body.unset : [];
        const variables = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? body.variables : undefined;
        const merged = await chats.mergeMetadata({ tree: chat.tree, at, set, unset, variables, actor });
        chat.session.answer(response);
        if (!merged.ok) {
            const there = await chats.stateAt({ tree: chat.tree, at, session: actor.session });
            return response.status(409).send({ ok: false, reason: merged.reason, state: there && 'state' in there ? there.state : {} });
        }
        return response.send({ ok: true });
    } catch (error) {
        console.error('Error saving chat metadata:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const name = chatName(request.body.file);
    const exportfilename = request.body.exportfilename;
    try {
        const chat = request.body.is_group ? await groupChatOf(request, name) : await chatOf(request, { avatar_url: request.body.avatar_url });
        const at = chat ? await chatNamePosition(chat, name) : undefined;
        const loaded = chat && at !== undefined ? await chat.store.chats.load({ tree: chat.tree, at, full: true }) : null;
        if (!loaded) {
            return response.status(404).json({ message: `Could not find chat to export: ${name}.` });
        }
        if (request.body.format === 'jsonl') {
            const header = { chat_metadata: loaded.metadata, user_name: 'unused', character_name: 'unused' };
            const jsonl = [header, ...loaded.messages].map(m => {
                const clean = /** @type {Record<string, unknown>} */ ({ ...m });
                delete clean.node_id;
                return JSON.stringify(clean);
            }).join('\n');
            return response.status(200).json({ message: `Chat saved to ${exportfilename}`, result: jsonl });
        }
        // Plain text export
        let buffer = '';
        for (const msg of loaded.messages) {
            if (msg.is_system === true) continue;
            if (msg.mes != null && msg.mes !== '') {
                const displayText = msg.extra?.display_text;
                const text = (displayText != null && displayText !== '') ? displayText : msg.mes;
                buffer += `${msg.name}: ${String(text).replace(/\r?\n/g, '\n')}\n\n`;
            }
        }
        return response.status(200).json({ message: `Chat saved to ${exportfilename}`, result: buffer });
    } catch (err) {
        console.error('Chat export failed:', err);
        return response.sendStatus(400);
    }
});

/**
 * Stores an imported chat (answer 3 of the cut): its messages from the tree's root as a branch of their own, and a
 * bookmark named after it at its last message; no session moves.
 * @param {import('../chat-request.js').ChatContext} chat
 * @param {string} chatText jsonl: a header line, then one message per line.
 * @param {string} name
 * @returns {Promise<string | null>} The bookmark's compat chat id (`b<id>`); null when it couldn't be stored.
 */
async function importChatText(chat, chatText, name) {
    const lines = chatText.split('\n').map(line => tryParse(line)).filter(x => x);
    const header = lines.length && !('mes' in lines[0]) ? lines.shift() : null;
    const imported = await chat.store.chats.importChat({
        tree: chat.tree, treeSpeaker: chat.treeSpeaker, name, messages: lines, metadata: header?.chat_metadata, actor: chat.session.actor(),
    });
    return imported.ok ? bookmarkCompatId(imported.bookmark) : null;
}

router.post('/group/import', async function (request, response) {
    const filedata = request.file;
    if (!filedata) return response.sendStatus(400);
    const pathToUpload = path.join(filedata.destination, filedata.filename);
    try {
        const chat = request.body?.group_id ? await chatContext(request, { group: String(request.body.group_id) }) : null;
        if (!chat) {
            console.error('Group chat import failed: no group was named (group_id).');
            return response.send({ error: true });
        }
        const name = await importChatText(chat, fs.readFileSync(pathToUpload, 'utf8'), humanizedDateTime());
        if (name === null) {
            console.error('Group chat import failed: the chat could not be stored.');
            return response.send({ error: true });
        }
        return response.send({ res: name });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    } finally {
        if (fs.existsSync(pathToUpload)) fs.unlinkSync(pathToUpload);
    }
});

router.post('/import', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) return response.sendStatus(400);
    if (!request.file) return response.sendStatus(400);

    const format = request.body.file_type;
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
    /** @type {string[]} */
    const fileNames = [];
    /** Chats of the upload that couldn't be stored, by name. @type {string[]} */
    const notSaved = [];
    const pathToUpload = path.join(request.file.destination, request.file.filename);

    try {
        const chat = await chatOf(request, { avatar_url: request.body.avatar_url });
        if (!chat) return response.send({ error: true });
        const data = fs.readFileSync(pathToUpload, 'utf8');
        const store = async (/** @type {string} */ chatText) => {
            const fileName = `${characterName} - ${humanizedDateTime()} imported`;
            const name = await importChatText(chat, chatText, fileName);
            if (name === null) notSaved.push(`${fileName}.jsonl`);
            else fileNames.push(`${name}.jsonl`);
        };

        if (format === 'json') {
            const jsonData = JSON.parse(data);
            // jsonData is parsed from an untrusted upload and format-sniffed below, so each importer takes `any`.
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
            const imported = importFunc(userName, characterName, jsonData);
            for (const c of Array.isArray(imported) ? imported : [imported]) await store(c);
        } else if (format === 'jsonl') {
            const lines = data.split('\n');
            const header = JSON.parse(lines[0]);
            if (!(header.user_name !== undefined || header.name !== undefined || header.chat_metadata !== undefined)) {
                console.error('Incorrect chat format .jsonl');
                return response.send({ error: true });
            }
            // Chub chats are flattened; a failure here keeps the chat as it came.
            let flattenedChat = data;
            try {
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                console.warn('Failed to flatten Chub Chat data: ', error);
            }
            await store(flattenedChat);
        } else {
            return response.send({ error: true });
        }
        return notSaved.length
            ? response.send({ error: true, message: `These chats could not be saved: ${notSaved.join(', ')}`, not_saved: notSaved, fileNames })
            : response.send({ res: true, fileNames });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    } finally {
        if (fs.existsSync(pathToUpload)) fs.unlinkSync(pathToUpload);
    }
});

router.post('/group/get', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }
        const name = chatName(request.body.id);
        const chat = await groupChatOf(request, name);
        const at = chat ? await chatNamePosition(chat, name) : undefined;
        const answer = chat && at !== undefined ? await chatArray(chat, at) : null;
        // An empty array, not a 404: getGroupChat() reads a miss as a new chat and shows the members' greetings.
        return response.send(answer ?? []);
    } catch (error) {
        console.error(error);
        return response.send([]);
    }
});

/**
 * A chat list row as upstream's chat pickers draw it.
 * @param {Record<string, any>} r A `chatList()` row with its `file_id`.
 * @param {boolean} withMetadata
 */
function pickerRow(r, withMetadata) {
    return {
        node_id: r.at,
        file_id: r.file_id,
        file_name: `${r.file_id}.jsonl`,
        label: r.label,
        file_size: formatBytes(0),
        chat_items: r.message_count,
        mes: r.last_mes || '[No messages]',
        last_mes: r.last_activity,
        chat_metadata: withMetadata ? r.chat_metadata : undefined,
    };
}

/** Every chat a group has (its chat list), as the chat pickers draw them. */
router.post('/group/branches', async (request, response) => {
    try {
        if (!request.body || !request.body.group_id) {
            return response.sendStatus(400);
        }
        const chat = await chatContext(request, { group: String(request.body.group_id) });
        if (!chat) return response.send([]);
        const withMetadata = !!request.body.metadata;
        return response.send((await chatListOf(chat, { withMetadata })).map(r => pickerRow(r, withMetadata)));
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
        const name = chatName(request.body.id);
        const chat = await groupChatOf(request, name);
        const row = chat ? (await chatListOf(chat)).find(r => r.file_id === name) : undefined;
        if (!row) return response.send({ match: false });
        return response.send({ match: true, ...pickerRow(row, false), mes: row.last_mes || '[The chat is empty]' });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Deletes a group's chat by name (answer 3 of the cut). Answers `{ ok, chats, chat_id }`, the group's chat list and
 * the request's compat chat id after it.
 */
router.post('/group/delete', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }
        const name = chatName(request.body.id);
        const chat = await groupChatOf(request, name);
        if (!chat || !await deleteChatNamed(request, response, chat, name)) {
            console.error('The group chat was not deleted.');
            return response.sendStatus(400);
        }
        return response.send({ ok: true, chats: (await chatListOf(chat)).map(r => r.file_id), chat_id: await compatChatIdOf(chat) });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Fills in `extra.gen_id` for character messages missing one before a group chat is stored: group regeneration and
 * swipe tracking need one on every character message. A message that has one keeps it; the value only needs to be
 * unique within this save.
 * @param {any[]} chatData Chat array as posted to /group/save, i.e. [header, ...messages].
 */
function assignMissingGenIds(chatData) {
    const baseId = Date.now();
    for (let index = 1; index < chatData.length; index++) {
        const message = chatData[index];
        if (!message || typeof message !== 'object' || message.is_user === true || message.is_system === true) {
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
        const chatData = request.body.chat;
        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
        assignMissingGenIds(chatData);
        const name = chatName(request.body.id);
        const chat = await groupChatOf(request, name);
        if (!chat) {
            console.error(`Refusing to save group chat "${name}": no group claims it.`);
            return response.status(400).send({ error: 'unknown_group' });
        }
        const { status, body } = await saveWholeChat(request, response, chat, name, chatData);
        const { file_name: chatId, ...rest } = /** @type {any} */ (body);
        return response.status(status).send(chatId === undefined ? rest : { ...rest, chat_id: chatId });
    } catch (error) {
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/** Chats `/search` reads at most per page. */
const SEARCH_PAGE_MAX = 500;

/**
 * Searches a character's or group's chat list: an item matches by its name, or by the messages on the path down to it
 * holding every word, or the whole query as a lower-cased substring (a capped scan of the messages' texts).
 * Upstream's callers (no `limit`) get every match, a bare array; with `limit` (1 to SEARCH_PAGE_MAX) the answer is a
 * page `{ results, cursor, scan_cursor, exact }`: `cursor` sent back for the next page, and once it is null
 * `scan_cursor` (when not null) sent back as `scan_cursor` for the scan's next results; `exact` is false while the
 * scan was capped.
 */
router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;
        if (!avatar_url && !group_id) return response.send([]);
        const limit = request.body.limit;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_PAGE_MAX)) {
            return response.status(400).send({ error: `limit must be an integer from 1 to ${SEARCH_PAGE_MAX}` });
        }
        const chat = await chatOf(request);
        if (!chat) return response.send(limit === undefined ? [] : { results: [], cursor: null, exact: true });
        const row = (/** @type {Record<string, any>} */ r) => {
            const id = r.bookmark != null ? bookmarkCompatId(r.bookmark) : sessionCompatId(String(r.session), chat.tree);
            return {
                node_id: r.at,
                file_name: id,
                label: r.name ?? null,
                file_size: null,
                message_count: r.message_count,
                last_mes: r.last_activity ?? '',
                preview_message: getPreviewMessage(r.last_mes ?? undefined),
            };
        };
        const search = typeof query === 'string' ? query : '';
        const session = chat.session.reader().session ?? undefined;
        if (limit !== undefined) {
            const after = typeof request.body.cursor === 'string' && /^\d+:\d+$/.test(request.body.cursor) ? request.body.cursor : undefined;
            const scanCursor = typeof request.body.scan_cursor === 'string' && /^m\d+$/.test(request.body.scan_cursor) ? request.body.scan_cursor : undefined;
            const page = await chat.store.chats.searchChatList({ tree: chat.tree, search, session, after, limit, scanCursor });
            return response.send({ results: page.rows.map(row), cursor: page.more && page.next !== undefined ? page.next : null, scan_cursor: page.scanCursor ?? null, exact: page.exact });
        }
        const results = [];
        // An item whose path holds scan matches in two reads comes once.
        const seen = new Set();
        const add = (/** @type {any[]} */ rows) => {
            for (const r of rows.map(row)) {
                if (!seen.has(r.file_name)) {
                    seen.add(r.file_name);
                    results.push(r);
                }
            }
        };
        /** @type {string | undefined} */
        let after;
        /** @type {string | undefined} */
        let scanCursor;
        for (;;) {
            const page = await chat.store.chats.searchChatList({ tree: chat.tree, search, session, after, limit: SEARCH_PAGE_MAX });
            add(page.rows);
            scanCursor ??= page.scanCursor;
            if (!page.more || page.next === undefined) break;
            after = page.next;
        }
        // Upstream's callers get every match: the scan goes on until it has read the owner's messages.
        while (scanCursor !== undefined) {
            const page = await chat.store.chats.searchChatList({ tree: chat.tree, search, session, limit: SEARCH_PAGE_MAX, scanCursor });
            add(page.rows);
            scanCursor = page.scanCursor;
        }
        return response.send(results);
    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

/** Messages `/search/messages` answers at most per page. */
const MESSAGE_SEARCH_PAGE_MAX = 200;

/**
 * Searches a character's or group's messages: `{ avatar_url | group_id, search, limit?, after?, scan_cursor? }` →
 * `{ rows, more, after?, total, totalExact, partial?, scanCursor? }` (`ChatEngine.searchMessages()`). Opening a
 * row moves the session there (`/open` with the chat, or `/message/select`).
 */
router.post('/search/messages', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { search, after, scan_cursor: scanCursor } = request.body ?? {};
        if (typeof search !== 'string') return response.status(400).send({ error: 'search is required' });
        const limit = request.body.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGE_SEARCH_PAGE_MAX) {
            return response.status(400).send({ error: `limit must be an integer from 1 to ${MESSAGE_SEARCH_PAGE_MAX}` });
        }
        const chat = await chatOf(request);
        if (!chat) return response.status(404).send({ error: 'unknown chat' });
        try {
            const found = await chat.store.chats.searchMessages({
                tree: chat.tree, search, limit,
                ...(typeof after === 'string' ? { after } : {}),
                ...(typeof scanCursor === 'string' ? { scanCursor } : {}),
            });
            // A row's depth is the engine's integer.
            return response.type('json').send(JSON.stringify(found, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)));
        } catch (err) {
            if (/invalid (scan )?cursor/.test(String(/** @type {any} */ (err)?.message))) return response.status(400).send({ error: 'invalid cursor' });
            throw err;
        }
    } catch (error) {
        console.error('Message search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

/** Conversations `/recent` lists at most. */
const RECENT_MAX = 1000;

const FORK_SESSION_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Forks the session a tab found another tab holding (see public/scripts/tab-session.js): `{ from, length, cursor,
 * chats: [{ tree: { avatar } | { group }, bookmark }] }`, the tab's last place in `from`'s history and its current
 * chats. Answers `{ session }`, the fork's UUID; 404 when `from` isn't a stored session.
 */
router.post('/session/fork', async function (request, response) {
    try {
        const { from, length, cursor, chats: tabChats } = request.body ?? {};
        const count = (/** @type {unknown} */ n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;
        if (typeof from !== 'string' || !FORK_SESSION_KEY.test(from) || !count(length) || !count(cursor) || (length > 0) !== (cursor > 0) || cursor > length || !Array.isArray(tabChats)) {
            return response.status(400).send({ error: 'invalid fork' });
        }
        const store = await requestStore(request);
        const owners = tabChats.map(c => (typeof c?.tree?.avatar === 'string' ? { avatar: c.tree.avatar } : typeof c?.tree?.group === 'string' ? { group: c.tree.group } : null));
        const trees = await store.people.trees(owners.map(o => o ?? {}));
        const chats = [];
        for (let i = 0; i < tabChats.length; i++) {
            const bookmark = tabChats[i]?.bookmark;
            if (trees[i] === null || typeof bookmark !== 'string') continue;
            chats.push({ tree: trees[i], bookmark });
        }
        const forked = await store.chats.forkSession({ from, length, cursor, chats, user: request.user.profile.handle });
        if (!forked.ok) return response.status(404).send({ error: forked.reason });
        return response.send({ session: forked.session });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Upstream's recent chats: the conversations (a bookmark, or a session's where it has no current chat) by their last
 * meaningful activity, the most recent first, one row per compat chat id; first the pinned chats (`pinned`:
 * `{ file_name, avatar | group }`, resolved by name in their character's or group's tree). `max` bounds the unpinned
 * ones.
 */
router.post('/recent', async function (request, response) {
    try {
        /** @type {{ file_name?: string, avatar?: string, group?: string }[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];
        const max = Math.min(RECENT_MAX, Math.max(0, parseInt(request.body.max ?? RECENT_MAX) || 0));
        const withMetadata = !!request.body.metadata;
        const store = await requestStore(request);
        const { chats } = store;

        const ownerOf = async (/** @type {bigint} */ tree) => {
            const [key] = await store.lib.store.libraryKeys([tree]);
            if (!key) return null;
            return key.type === TYPE.group ? { group: key.key } : { avatar: key.key };
        };
        const info = (/** @type {Record<string, any>} */ r, /** @type {object} */ owner, /** @type {string} */ id) => ({
            node_id: r.at,
            file_name: `${id}.jsonl`,
            label: r.name ?? null,
            ...owner,
            file_size: 0,
            chat_items: r.message_count,
            mes: r.last_mes || '[No messages]',
            last_mes: r.last_activity,
            chat_metadata: withMetadata ? r.chat_metadata : undefined,
        });

        const pinned = [];
        for (const pin of pinnedChats) {
            const owner = typeof pin.group === 'string' && pin.group !== '' ? { group: pin.group } : typeof pin.avatar === 'string' && pin.avatar !== '' ? { avatar: pin.avatar } : null;
            if (!owner || typeof pin.file_name !== 'string') continue;
            const chat = await chatContext(request, owner);
            if (!chat) continue;
            // A pin holds a chat id, or an old chat name (a label, resolved in its own tree while one bookmark has it).
            const found = await chat.store.chats.resolveChatName({ tree: chat.tree, name: chatName(pin.file_name) });
            if (!found) continue;
            const id = 'bookmark' in found ? bookmarkCompatId(found.bookmark) : sessionCompatId(found.session, chat.tree);
            const row = (await chatListOf(chat, { withMetadata })).find(r => r.file_id === id);
            if (row) pinned.push(info(row, owner, row.file_id));
        }
        const recent = await chats.recentConversations({ limit: max, withMetadata });
        const rows = [];
        for (const r of recent.rows) {
            const owner = await ownerOf(r.tree);
            if (!owner) continue;
            if (pinned.some(p => p.file_name === `${r.id}.jsonl` && (p.group ?? p.avatar) === (owner.group ?? owner.avatar))) continue;
            rows.push(info(r, owner, r.id));
        }
        return response.send([...pinned, ...rows]);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
