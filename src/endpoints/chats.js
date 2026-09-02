import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import readline from 'node:readline';
import process from 'node:process';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import {
    getConfigValue,
    humanizedDateTime,
    tryParse,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    readFirstLine,
    isPathUnderParent,
} from '../util.js';
import { bumpCharacterDateLastChat, bumpGroupChatStats } from '../character-metadata-db.js';
import { resolveGroupOwner } from '../character-shallow.js';
import { migrateOwnerOnTouch } from '../message-tree-migration.js';
import { upsertChatFromSave, upsertChatFromParse, getChatRow, deleteChatRow, renameChatRow } from '../chat-metadata-db.js';
import { searchChatMessages } from './chat-content-search-index.js';
import {
    isAvailable as isTreeAvailable, hasSavedChats,
    saveChatToTree, loadBranch, forkBranch, labelNode,
    deleteBranch, renameBranch as renameBranchInTree, listBranches, listRecentBranches, searchBranchesByContent,
    renameCharacterInMessages, getAlternatives, getContinuation, getAncestorPath, editMessage, editMessages, appendMessages, addAlternatives, setChatMetadata, getOpeningAlternatives, addOpeningAlternatives, loadAtNode, listLabels, setNodeMetadata, selectDefaultChild, endPathAt,
} from '../message-tree-db.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';

/**
 * Builds a stable filename key for a chat's backups.
 * Non-ASCII characters are replaced with underscores, so names such as CJK ones
 * would all collapse to the same key and share one backup quota. A short hash of
 * the raw name keeps those keys distinct while ASCII names stay unchanged (#5780).
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
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backup directory.
 * @param {string} name The name of the chat.
 * @param {string} data The serialized chat to save.
 * @param {string} backupPrefix The file prefix. Typically CHAT_BACKUPS_PREFIX.
 * @returns
 */
function backupChat(directory, name, data, backupPrefix = CHAT_BACKUPS_PREFIX) {
    try {
        if (!isBackupEnabled) { return; }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
        }
        name = getBackupKey(name);

        const backupFile = path.join(directory, `${backupPrefix}${name}_${generateTimestamp()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        removeOldBackups(directory, `${backupPrefix}${name}_`);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        removeOldBackups(directory, backupPrefix, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not backup chat for ${name}`, err);
    }
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

/**
 * Gets a backup function for a user and chat.
 * Throttling is keyed per user and chat so that rapid saves in one chat cannot
 * swallow the throttled backup of another chat saved in the same window.
 * @param {string} handle User handle
 * @param {string} name The name of the chat, as passed to backupChat
 * @returns {typeof backupChat} Backup function
 */
function getBackupFunction(handle, name) {
    const key = `${handle} ${name}`;
    if (!backupFunctions.has(key)) {
        backupFunctions.set(key, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(key) || (() => { });
}

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
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
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Chat data
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
        const isUser = !!message.userId;
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
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
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

    const newChats = (jsonData.histories.histories ?? []).map(history => newChats.push(convert(history).map(obj => JSON.stringify(obj)).join('\n')));
    return newChats;
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
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
    if (data.prompt) {
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
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
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
 * Checks if the chat being saved has the same integrity as the one being loaded.
 * @param {string} filePath Path to the chat file
 * @param {string} integritySlug Integrity slug
 * @returns {Promise<boolean>} Whether the chat is intact
 */
async function checkChatIntegrity(filePath, integritySlug) {
    // If the chat file doesn't exist, assume it's intact
    if (!fs.existsSync(filePath)) {
        return true;
    }

    // If the chat file is empty, there is nothing that could be lost by overwriting it
    if (fs.statSync(filePath).size === 0) {
        return true;
    }

    // Parse the first line of the chat file as JSON. Strip a UTF-8 BOM an external editor may have added.
    const firstLine = await readFirstLine(filePath);
    const jsonData = tryParse(String(firstLine ?? '').replace(/^\uFEFF/, ''));

    // If the first line of a non-empty file is not a JSON object, the file may be corrupted or truncated.
    // Fail the check so the client asks for an explicit overwrite confirmation instead of silently losing data.
    if (typeof jsonData !== 'object' || jsonData === null || Array.isArray(jsonData)) {
        console.warn(`File "${filePath}" is not empty, but its first line could not be parsed as a chat header. Overwriting it requires an explicit confirmation.`);
        return false;
    }

    const chatIntegrity = jsonData?.chat_metadata?.integrity;

    // If the chat has no integrity metadata, assume it's intact (legacy chats created before integrity checks existed)
    if (!chatIntegrity) {
        console.debug(`File "${filePath}" does not have integrity metadata matching "${integritySlug}". The integrity validation has been skipped.`);
        return true;
    }

    // Check if the integrity matches
    const matches = chatIntegrity === integritySlug;

    if (!matches) {
        // TEMP DEBUG (see docs/design or ask before removing): capturing facts for the
        // /newchat double-save integrity mismatch repro. Remove once root-caused.
        const stat = fs.statSync(filePath);
        console.error(`[integrity-debug] mismatch for "${filePath}": expected="${integritySlug}" onDisk="${chatIntegrity}" fileMtime=${stat.mtime.toISOString()} fileCtime=${stat.ctime.toISOString()} fileSize=${stat.size} now=${new Date().toISOString()}`);
    }

    return matches;
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
 * @param {object} additionalData - Additional data to include in the result
 * @param {boolean} withMetadata - Whether to read chat metadata
 * @param {ChatMatchFunction|null} matcher - Optional function to match messages
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: string[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(pathToFile, additionalData = {}, withMetadata = false, matcher = null) {
    const parsedPath = path.parse(pathToFile);
    const hasMatcher = (typeof matcher === 'function');

    // A chat that is deleted while a scan is running is not an error: treat it like a corrupted chat and move on.
    const chatVanished = () => {
        console.warn('Chat file was deleted while it was being scanned:', pathToFile);
        return { match: false };
    };

    let stats;
    try {
        stats = await fs.promises.stat(pathToFile);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return chatVanished();
        }
        throw error;
    }

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
        fileStream.on('error', (error) => {
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
        rl.on('error', (error) => {
            if (error.code === 'ENOENT') {
                res(chatVanished());
                return;
            }
            rej(error);
        });

        let lastLine;
        let itemCounter = 0;
        let hasAnyMatch = false;
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
            if (lastLine) {
                const jsonData = tryParse(lastLine);
                if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                    chatData.chat_items = (itemCounter - 1);
                    chatData.mes = jsonData.mes || '[The message is empty]';
                    chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
                    chatData.match = hasMatcher ? hasAnyMatch : true;

                    res(chatData);
                } else {
                    console.warn('Found an invalid or corrupted chat file:', pathToFile);
                    res({});
                }
            } else {
                // The file was truncated after the stat reported a non-zero size
                res({});
            }
        });
    });
}

/**
 * Cache-first counterpart to getChatInfo(): serves a chat's info from chat-metadata-db.js's per-file row when
 * that row's stored mtime still matches the file's current mtime (no I/O beyond the DB lookup - no readline, no
 * stat even, since the caller already has `mtimeMs` from its own directory-listing pass), and transparently
 * falls back to a full getChatInfo() parse (caching the result for next time) on a miss or stale row.
 *
 * Never used for a real content-matching search (a `matcher` query) - a cached row only ever holds the LAST
 * message's preview, not the full chat text, so it can't answer "does this chat contain X" correctly. Callers
 * that need to run `matcher` must call getChatInfo() directly, same as before this function existed.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} pathToFile
 * @param {number} mtimeMs The file's current mtime, already known by the caller
 * @param {object} additionalData
 * @param {boolean} withMetadata
 * @returns {Promise<ChatInfo>}
 */
export async function getOrComputeChatInfo(directories, pathToFile, mtimeMs, additionalData = {}, withMetadata = false) {
    const row = await getChatRow(directories, pathToFile);

    if (row && row.mtime === Math.round(mtimeMs)) {
        const parsedPath = path.parse(pathToFile);
        const chatData = {
            match: true,
            file_id: parsedPath.name,
            file_name: parsedPath.base,
            file_size: formatBytes(row.file_size),
            chat_items: row.message_count,
            mes: row.preview ?? '[The chat is empty]',
            last_mes: row.last_mes ?? mtimeMs,
            ...additionalData,
        };
        if (withMetadata && row.chat_metadata_json) {
            const parsedMetadata = tryParse(row.chat_metadata_json);
            if (parsedMetadata) {
                chatData.chat_metadata = parsedMetadata;
            }
        }
        return chatData;
    }

    const chatInfo = await getChatInfo(pathToFile, additionalData, withMetadata);

    // Cache the freshly computed info for the next read - not awaited, so a cache miss doesn't pay for the
    // write on top of the parse it just did. Skipped for a vanished/corrupted file (getChatInfo() returns
    // `{ match: false }` or `{}` for those, neither of which carries a file_name) - nothing usable to cache.
    if (chatInfo.file_name) {
        fs.promises.stat(pathToFile)
            .then(stats => upsertChatFromParse(directories, pathToFile, stats, chatInfo))
            .catch(err => console.error('[chat-metadata] Failed to cache chat metadata after parse:', err));
    }

    return chatInfo;
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
    constructor(...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);
        // Maintains proper stack trace for where our error was thrown (non-standard)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, IntegrityMismatchError);
        }
        this.date = new Date();
    }
}

/**
 * Tries to save the chat data to a file, performing an integrity check if required.
 *
 * Also rotates the integrity slug on every successful write when integrity tracking is enabled (regardless of
 * whether this particular call skipped the check via `skipIntegrityCheck`/force) and returns the new slug to
 * the caller. This is the other half of the fix `checkChatIntegrity` needs: previously the slug a tab first
 * loaded was carried forward unchanged on every subsequent save, including the one written to disk - so the
 * "expected" slug on file never diverged from what any tab that had ever loaded the chat was sending, and the
 * check could never actually catch a stale write. Minting a fresh slug here, writing it into the saved file,
 * and handing it back to the caller (which must feed it into that tab's *next* save, see
 * `saveChat()`/`saveGroupChat()` in the client) means a second tab whose last-known slug predates this write
 * will correctly fail the check on its next save attempt instead of silently clobbering it.
 * @param {Array} chatData The chat array to save.
 * @param {string} filePath Target file path for the data.
 * @param {boolean} skipIntegrityCheck If undefined, the chat's integrity will not be checked.
 * @param {string} handle The users handle, passed to getBackupFunction.
 * @param {string} cardName Passed to backupChat.
 * @param {string} backupDirectory Passed to backupChat.
 * @param {import('../users.js').UserDirectoryList} [directories] When given, feeds chat-metadata-db.js's
 * write-path hook (upsertChatFromSave()) right after the write succeeds - the same "hook alongside the slug
 * rotation, don't duplicate/conflict with it" placement the integrity slug above uses. Computed straight from
 * `chatData` (already in memory) plus one post-write stat, so it costs no extra parse of the file this call just
 * wrote. Optional (rather than required) so any caller that genuinely has no directories to offer - none exist
 * today, both /save and /group/save always have `request.user.directories` - degrades to "metadata store not
 * updated for this write" instead of throwing.
 * @returns {Promise<string|undefined>} The new integrity slug written to the file, or undefined if integrity
 * tracking is disabled (`backups.chat.checkIntegrity` config) or the chat has no header to carry a slug.
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory, directories) {
    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const chatIntegritySlug = doIntegrityCheck ? chatData?.[0]?.chat_metadata?.integrity : undefined;

    if (chatIntegritySlug && !await checkChatIntegrity(filePath, chatIntegritySlug)) {
        throw new IntegrityMismatchError(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatIntegritySlug}".`);
    }
    /** @type {string|undefined} */
    let nextIntegritySlug;
    if (checkIntegrity && chatData?.[0]?.chat_metadata && typeof chatData[0].chat_metadata === 'object') {
        nextIntegritySlug = crypto.randomUUID();
        chatData[0].chat_metadata.integrity = nextIntegritySlug;
    }

    const jsonlData = chatData?.map(m => JSON.stringify(m)).join('\n');
    tryWriteFileSync(filePath, jsonlData);
    getBackupFunction(handle, cardName)(backupDirectory, cardName, jsonlData);

    if (directories) {
        try {
            const stats = await fs.promises.stat(filePath);
            const fileSizeBytes = Buffer.byteLength(jsonlData ?? '', 'utf8');
            await upsertChatFromSave(directories, filePath, chatData, stats.mtimeMs, fileSizeBytes);
        } catch (err) {
            console.error('[chat-metadata] Failed to update chat metadata store after save:', err);
        }
    }
    return nextIntegritySlug;
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        const chatName = String(request.body.file_name);

        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }

        // Whole-array save. Kept for parity with upstream SillyTavern: extensions and anything written
        // against the stock API call this, and breaking it isn't on the table.
        //
        // Our own frontend never reaches it. It writes through the named operations
        // (/message/edit, /message/append, /message/alternative, /message/select, /metadata), each of
        // which names the row it acts on - so our client cannot speak for a row it never received,
        // which is the shape that let a windowed load's unfilled slots overwrite stored greetings.
        // Migrate-on-touch, then one path. This does NOT ask whether the character is migrated and pick
        // a route from the answer - see migrateOwnerOnTouch()'s doc comment on why that shape is banned.
        // It states that by the time the next line runs, this owner's chats are in the tree, because if
        // they weren't, they are now. Whether the tree is where chats live is not a per-character
        // question; isTreeAvailable() is the only thing that answers it, and it answers globally.
        const useTree = await isTreeAvailable(request.user.directories);
        if (useTree) {
            await migrateOwnerOnTouch(request.user.directories, {
                ownerId: cardName,
                chatDir: path.join(request.user.directories.chats, cardName),
            });
            const result = await saveChatToTree(request.user.directories, cardName, chatName, chatData, false);
            if (result) {
                await bumpCharacterDateLastChat(request.user.directories, String(request.body.avatar_url)).catch(err =>
                    console.error(`Could not bump date_last_chat for ${cardName}:`, err));
                return response.send({
                    ok: true,
                    integrity: result.integrity,
                    assigned_node_ids: result.assignedNodeIds,
                });
            }
            // If saveChatToTree returned null (DB unavailable), fall through to JSONL
        }

        // JSONL fallback path (non-migrated or tree DB unavailable)
        const chatFileName = `${sanitize(chatName)}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        const integrity = await trySaveChat(chatData, chatFilePath, request.body.force, handle, cardName, request.user.directories.backups, request.user.directories);
        await bumpCharacterDateLastChat(request.user.directories, String(request.body.avatar_url)).catch(err =>
            console.error(`Could not bump date_last_chat for ${cardName}:`, err));
        return response.send({ ok: true, integrity });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * Gets the chat as an object.
 * @param {string} chatFilePath The full chat file path.
 * @returns {Array}} If the chatFilePath cannot be read, this will return [].
 */
export function getChatData(chatFilePath) {
    let chatData = [];

    const chatJSON = tryReadFileSync(chatFilePath) ?? '';
    if (chatJSON.length > 0) {
        const lines = chatJSON.split('\n');
        // Iterate through the array of strings and parse each line as JSON
        chatData = lines.map(line => tryParse(line)).filter(x => x);
    } else {
        console.warn(`File not found: ${chatFilePath}. The chat does not exist or is empty.`);
    }

    return chatData;
}

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatName = String(request.body.file_name || '');

        const useTree = await isTreeAvailable(request.user.directories);
        if (useTree && chatName) {
            // Same migrate-on-touch precondition /save runs, for the same reason: opening a chat is a
            // touch. A read has to do it too, or the very first thing a never-migrated character does
            // is render blank and then have an autosave write a fresh branch beside history the tree
            // has never been shown.
            await migrateOwnerOnTouch(request.user.directories, {
                ownerId: dirName,
                chatDir: path.join(request.user.directories.chats, dirName),
            });
            // The pointer may be a node id or a legacy chat name. A node id is what identifies a
            // position; a name only ever resolved to one by lookup, and not uniquely - `label` is not
            // unique per owner, so name lookup picks whichever row sorts first.
            //
            // Both are accepted so an existing pointer keeps working while the client moves over. A
            // node id is tried first: it is exact, and a miss falls through to the name path rather
            // than failing.
            const result = await loadAtNode(request.user.directories, dirName, chatName)
                ?? await loadBranch(request.user.directories, dirName, chatName);
            if (result) {
                // Assemble in the same format as JSONL: [header, ...messages]
                // _tree_stored flag lets the client use tree-specific APIs (fork, label)
                /** @type {any} */
                const header = {
                    chat_metadata: { ...result.metadata, _tree_stored: true },
                    user_name: 'unused',
                    character_name: 'unused',
                };
                return response.send([header, ...result.messages]);
            }
            // Branch not found in tree. The JSONL fallback below only returns {} when no chatName was
            // given at all (a brand-new character with nothing selected yet) - once a chatName IS given,
            // a missing file 404s, full stop, whether the chat is "new" or not. The client already
            // relies on that: doNewChat()/getChat({ isNewChat: true }) passes isNewChat precisely so a
            // 404 for a freshly-minted, definitely-nonexistent name is treated as an empty chat with no
            // side effects (see getChat() in script.js), while a 404 for anything else is treated as
            // "this character's persisted chat pointer names something that's gone" and triggers
            // replaceCurrentChat() to recover onto a real chat instead of silently rendering blank.
            // Returning {} here for every miss (as this used to) collapses that distinction: a stale or
            // wrong chat-name pointer for an EXISTING character looks identical to a legitimately new,
            // unsaved chat, so the recovery path never fires and the very next autosave can create a
            // brand-new near-empty branch under the stale name - right beside whatever branch actually
            // holds the real history - instead of surfacing the mismatch.
            return response.status(404).send({ error: 'not_found' });
        }

        // JSONL fallback path
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }
        const chatDirExists = fs.existsSync(directoryPath);

        if (!chatDirExists) {
            fs.mkdirSync(directoryPath);
            return response.send({});
        }

        if (!chatName) {
            return response.send({});
        }

        const chatFileName = `${chatName}.jsonl`;
        const chatFilePath = path.join(directoryPath, sanitize(chatFileName));

        if (!fs.existsSync(chatFilePath)) {
            return response.status(404).send({ error: 'not_found' });
        }

        return response.send(getChatData(chatFilePath));
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const oldName = String(request.body.original_file).replace(/\.jsonl$/, '');

        // A group's owner is not in this request - `avatar_url` means nothing for one. It is resolved from
        // the chat being renamed, which the group's descriptor still lists at this point: the client updates
        // its `chats` array only after this call returns.
        /** @type {string|null} */
        let ownerId = null;
        if (request.body.is_group) {
            ownerId = (await touchGroupOwner(request.user.directories, { chatId: oldName, groupId: request.body.group_id }))?.id ?? null;
        } else {
            ownerId = String(request.body.avatar_url).replace('.png', '');
            await migrateOwnerOnTouch(request.user.directories, {
                ownerId,
                chatDir: path.join(request.user.directories.chats, ownerId),
            });
        }

        // hasSavedChats() is not asking whether this owner is migrated (it cannot answer that - see its own
        // doc comment); it is asking whether there is any named chat here to rename at all. After the
        // migrate-on-touch above, an owner with history has it in the tree, so a `false` here means there is
        // genuinely nothing named, and the file path below is the right place to look.
        if (ownerId && await hasSavedChats(request.user.directories, ownerId)) {
            const newName = String(request.body.renamed_file).replace(/\.jsonl$/, '');
            const renamed = await renameBranchInTree(request.user.directories, ownerId, oldName, newName);
            if (renamed) {
                return response.send({ ok: true, sanitizedFileName: newName });
            }
            return response.status(400).send({ error: true });
        }

        // JSONL fallback
        const pathToFolder = request.body.is_group
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
        if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, pathToFolder)) {
            return response.sendStatus(400);
        }
        const pathToOriginalFile = path.join(pathToFolder, sanitize(request.body.original_file));
        const pathToRenamedFile = path.join(pathToFolder, sanitize(request.body.renamed_file));
        const sanitizedFileName = path.parse(pathToRenamedFile).name;
        console.debug('Old chat name', pathToOriginalFile);
        console.debug('New chat name', pathToRenamedFile);

        if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
            console.error('Either Source or Destination files are not available');
            return response.status(400).send({ error: true });
        }

        fs.copyFileSync(pathToOriginalFile, pathToRenamedFile);
        fs.unlinkSync(pathToOriginalFile);
        console.info('Successfully renamed chat file.');

        await renameChatRow(request.user.directories, pathToOriginalFile, pathToRenamedFile).catch(err =>
            console.error('[chat-metadata] Failed to update chat metadata store after rename:', err));

        return response.send({ ok: true, sanitizedFileName });
    } catch (error) {
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatName = String(request.body.chatfile).replace(/\.jsonl$/, '');

        // Tree DB path
        if (await hasSavedChats(request.user.directories, dirName)) {
            const deleted = await deleteBranch(request.user.directories, dirName, chatName);
            if (deleted) {
                return response.send({ ok: true });
            }
            return response.sendStatus(400);
        }

        // JSONL fallback
        const chatFileName = String(request.body.chatfile);
        const chatFilePath = path.join(request.user.directories.chats, dirName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }
        if (tryDeleteFile(chatFilePath)) {
            await deleteChatRow(request.user.directories, chatFilePath).catch(err =>
                console.error('[chat-metadata] Failed to update chat metadata store after delete:', err));
            return response.send({ ok: true });
        } else {
            console.error('The chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

// ---------------------------------------------------------------------------
//  Tree-specific endpoints (fork, label, list-branches)
// ---------------------------------------------------------------------------

/**
 * DEPRECATED, and unused by this frontend.
 *
 * On the tree path a fork was only ever a label: nothing is copied, because the node already exists
 * and is shared. So this and /api/chats/label were two routes doing one thing, and the client now uses
 * the label one for both branching and bookmarking.
 *
 * Kept for extensions written against the stock API.
 */
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

/**
 * Labels (pins/checkpoints) a message node. Replaces the old checkpoint system where a full
 * chat copy was made; in the tree model a checkpoint is just a label on an existing node.
 */
router.post('/label', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { node_id, label } = request.body;
        if (!node_id) {
            return response.sendStatus(400);
        }

        const ok = await labelNode(request.user.directories, String(node_id), label || null);
        return response.send({ ok });
    } catch (error) {
        console.error('Error labeling node:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Renames the character name inside all messages for a character, directly in the DB.
 * Replaces the client-side renamePastChats round-trip-per-chat approach (which fetched and
 * re-saved every chat file individually) with a single DB operation.
 */
router.post('/tree/rename-in-content', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { avatar_url, new_name } = request.body;
        if (!avatar_url || !new_name) {
            return response.sendStatus(400);
        }

        const ownerId = String(avatar_url).replace('.png', '');

        // Nothing to rename the speaker in. This is a no-op, not a failure - respond 200 with an
        // explicit flag so the client can tell it apart from an actual rename failure without
        // string-matching an error message against an ambiguous 400.
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

/**
 * Lists all branches for a character in the tree DB. Supplements the existing chat listing
 * endpoint in characters.js.
 */
router.post('/tree/branches', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const ownerId = String(request.body.avatar_url).replace('.png', '');
        const branches = await listBranches(request.user.directories, ownerId);

        // Transform to the format the client's chat listing expects
        const result = branches.map(b => ({
            node_id: b.id,
            file_name: b.name,
            file_size: 0, // Not meaningful for tree-stored chats
            message_count: b.message_count,
            last_mes: b.last_mes || '',
            chat_metadata: b.metadata ? JSON.parse(b.metadata) : {},
        }));

        return response.send(result);
    } catch (error) {
        console.error('Error listing tree branches:', error);
        return response.status(500).send([]);
    }
});

/**
 * Fills in the alternatives a chat load left as holes.
 *
 * A load ships a window around the selected alternative and holes elsewhere, because a wide fork
 * point can carry over a thousand of them and shipping their text costs hundreds of KB nobody reads.
 * This is how the client gets the rest, at the moment it actually needs them.
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

/**
 * The path from root down to a node, for when the client already has part of a conversation loaded
 * and a bookmark it just picked sits somewhere off that path - this is what it needs to bridge the
 * gap, without re-fetching whatever prefix is already shared.
 */
router.post('/ancestry', async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) {
            return response.status(400).send({ error: 'node_id is required' });
        }
        const result = await getAncestorPath(request.user.directories, nodeId);
        if (!result) {
            return response.status(404).send({ error: 'Node not found' });
        }
        return response.send({ messages: result });
    } catch (error) {
        console.error('Error fetching ancestry:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * The conversation below a node, for when the client switches an earlier message to a different
 * alternative and needs to move onto that alternative's path.
 */
router.post('/continuation', async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) {
            return response.status(400).send({ error: 'node_id is required' });
        }
        const branchName = request.body.chat_name ? String(request.body.chat_name) : null;
        const result = await getContinuation(request.user.directories, nodeId, branchName);
        if (!result) {
            return response.status(404).send({ error: 'Node not found' });
        }
        return response.send(result);
    } catch (error) {
        console.error('Error fetching continuation:', error);
        return response.status(500).send({ error: true });
    }
});

// ---------------------------------------------------------------------------
//  The operations a save is made of.
//
//  These replace handing the whole conversation over on every save. The tree already stores the
//  path, so there is nothing to restate; each route names the single row it acts on, which means a
//  row the client never received simply cannot be addressed.
// ---------------------------------------------------------------------------

/**
 * Which owner an operation is against.
 *
 * An owner is a character for one kind of chat and a group for the other, and the tree does not care
 * which - `owner_id` is just a string it filters on. What differs is how the request names it: a
 * character by its avatar, a group by its own id, because a group has no avatar to be named by. So a
 * request that carries `group_id` is speaking for a group, and nothing downstream needs to know that.
 *
 * No migration precondition here on purpose. These routes act on a row the client is already holding,
 * which it can only be holding because a load put it there, and the load is what runs migrate-on-touch.
 * Re-asking on every keystroke-level operation would be the per-request check this design refuses.
 */
const ownerOf = (request) => (request.body.group_id
    ? String(request.body.group_id)
    : String(request.body.avatar_url).replace('.png', ''));

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

/**
 * Applies one change that spans many messages, as one thing.
 *
 * Attributing a run of messages to a persona, or hiding a range, is a single act - it was being sent
 * as one request per message, which is N round trips for one decision and N chances to end up half
 * applied. Refusals are reported per message rather than stopping the rest.
 */
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

/** Appends one or more messages after a node. */
router.post('/message/append', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const after = String(request.body.after_node_id || '');
        if (!after) return response.status(400).send({ error: 'after_node_id is required' });

        const contents = Array.isArray(request.body.messages) ? request.body.messages : [];
        const result = await appendMessages(request.user.directories, ownerOf(request), after, contents);

        // Appending is what "you used this chat" means, so this is where the character's recency
        // stamp belongs. It used to ride on the whole-array save, which our client no longer calls -
        // so the list kept its order in-session (the client updates its own store) and lost it on
        // reload, because nothing was persisting it.
        if (result.ok && contents.length) {
            await bumpCharacterDateLastChat(request.user.directories, String(request.body.avatar_url)).catch(err =>
                console.error('Could not bump date_last_chat:', err));
        }

        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error appending messages:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * The openings a character can start on: every greeting any of its chats has ever opened from.
 *
 * Addressed by character rather than by node, because starting a chat has no node to start from yet.
 * A new chat picks one of these and holds its id, instead of copying a greeting off the card into a
 * fresh message the way file-backed chats had to.
 *
 * The card's own greetings are merged in at read time. An entry with no node_id is a greeting that
 * exists on the card and has no row yet; it gets one when someone actually opens a conversation on
 * it. That is why nothing needs syncing: edit a greeting on the card and the next read reflects it.
 */
router.post('/openings', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const offset = Number.isFinite(Number(request.body.offset)) ? Number(request.body.offset) : undefined;
        const limit = Number.isFinite(Number(request.body.limit)) ? Number(request.body.limit) : undefined;
        // The card's greetings come from the caller and are merged read-only. Nothing is written, so
        // this is not the client asserting anything about stored rows - it is supplying the card's
        // current contents, which it legitimately holds, for a union computed here.
        const cardGreetings = Array.isArray(request.body.card_greetings) ? request.body.card_greetings : [];
        const result = await getOpeningAlternatives(request.user.directories, ownerOf(request), { offset, limit }, cardGreetings);
        if (!result) return response.status(404).send({ error: 'Tree storage unavailable' });
        return response.send(result);
    } catch (error) {
        console.error('Error listing openings:', error);
        return response.status(500).send({ error: true });
    }
});

/** Makes sure these openings exist for a character, creating its anchor if this is the first. */
router.post('/openings/ensure', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const contents = request.body.contents ?? request.body.content;
        if (!contents) return response.status(400).send({ error: 'content or contents is required' });

        const result = await addOpeningAlternatives(request.user.directories, ownerOf(request), contents);
        return response.status(result.ok ? 200 : 409).send(result);
    } catch (error) {
        console.error('Error ensuring openings:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Adds alternatives alongside an existing node - more options at the same fork.
 *
 * Idempotent, so a set can be asserted repeatedly. That is how a character's current greetings stay
 * present in every chat, including ones that existed before the greeting was added, without the fork
 * growing on every open.
 */
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

/**
 * Shows this alternative. The fork it belongs to follows from the node itself, so the caller never
 * names a parent and therefore can never name the wrong one.
 */
/**
 * Ends the conversation at this node: it stops showing anything after it.
 *
 * The counterpart to select. Deleting the tail of a chat, or cutting it back to a point, is this and
 * not a removal - the messages below keep their rows, their text and their own continuations, and
 * selecting one again restores the whole thing. Nothing in this store is ever destroyed.
 */
router.post('/message/end-path', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const ok = await endPathAt(request.user.directories, ownerOf(request), nodeId);
        return response.status(ok ? 200 : 409).send({ ok, reason: ok ? undefined : 'unknown node' });
    } catch (error) {
        console.error('Error ending the path:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/message/select', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const child = String(request.body.node_id || '');
        if (!child) return response.status(400).send({ error: 'node_id is required' });

        const ok = await selectDefaultChild(request.user.directories, child);
        return response.status(ok ? 200 : 409).send({ ok, reason: ok ? undefined : 'unknown node, or it has no parent' });
    } catch (error) {
        console.error('Error selecting alternative:', error);
        return response.status(500).send({ error: true });
    }
});

// ---------------------------------------------------------------------------
//  Node-addressed reads.
//
//  There is no chat. There is a tree, and a label is a bookmark someone put on a node they wanted to
//  get back to. A node id is the only thing that identifies a position: `label` is not unique per
//  owner (12 duplicate pairs in a real install), so looking one up by name silently picks whichever
//  row comes first.
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

/** Replaces the metadata stored on a node. */
router.post('/node/metadata', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const nodeId = String(request.body.node_id || '');
        if (!nodeId) return response.status(400).send({ error: 'node_id is required' });

        const result = await setNodeMetadata(request.user.directories, ownerOf(request), nodeId, request.body.metadata);
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

        const result = await setChatMetadata(request.user.directories, ownerOf(request), chatName, request.body.metadata);
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

    const ownerId = request.body.is_group ? null : String(request.body.avatar_url).replace('.png', '');
    const chatName = String(request.body.file).replace(/\.jsonl$/, '');
    const exportfilename = request.body.exportfilename;

    // Tree DB path: generate JSONL from tree data on demand
    if (ownerId && await hasSavedChats(request.user.directories, ownerId)) {
        try {
            const result = await loadBranch(request.user.directories, ownerId, chatName);
            if (!result) {
                return response.status(404).json({ message: `Branch "${chatName}" not found in tree DB.` });
            }

            const header = { chat_metadata: result.metadata, user_name: 'unused', character_name: 'unused' };
            const allData = [header, ...result.messages];

            if (request.body.format === 'jsonl') {
                const jsonl = allData.map(m => {
                    const clean = { ...m };
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
                if (msg.is_system) continue;
                if (msg.mes) {
                    const name = msg.name;
                    const message = (msg?.extra?.display_text || msg?.mes || '').replace(/\r?\n/g, '\n');
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
    }

    // JSONL fallback path
    const pathToFolder = request.body.is_group
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = path.join(pathToFolder, sanitize(request.body.file));
    if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, filename)) {
        return response.sendStatus(400);
    }
    if (!fs.existsSync(filename)) {
        const errorMessage = {
            message: `Could not find JSONL file to export. Source chat file: ${filename}.`,
        };
        console.error(errorMessage.message);
        return response.status(404).json(errorMessage);
    }
    try {
        if (request.body.format === 'jsonl') {
            try {
                const rawFile = fs.readFileSync(filename, 'utf8');
                return response.status(200).json({
                    message: `Chat saved to ${exportfilename}`,
                    result: rawFile,
                });
            } catch (err) {
                console.error(err);
                return response.status(500).json({
                    message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
                });
            }
        }

        const readStream = fs.createReadStream(filename);
        const rl = readline.createInterface({ input: readStream });
        let buffer = '';
        rl.on('line', (line) => {
            const data = JSON.parse(line);
            if (data.is_system) return;
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        });
        rl.on('close', () => {
            console.info(`Chat exported as ${exportfilename}`);
            return response.status(200).json({
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            });
        });
    } catch (err) {
        console.error('chat export failed.', err);
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

        // Dropping the file into groupChats/ and walking away is what this used to do, and it is the one
        // thing that must not happen once a group's chats are in the tree: the owner already has labeled
        // nodes, so migrate-on-touch correctly skips it forever, and the imported file sits on disk that
        // nothing will ever read. So an import is ingested the same way a save is - through the store,
        // under the group's owner id, sharing rows with whatever history it has a prefix in common with.
        //
        // touchGroupOwner() runs FIRST and its ordering is load-bearing: if this group is still on files,
        // its existing chats have to land in the tree before the import labels anything, or that label
        // flips the idempotency gate and strands the rest of the group's history.
        const useTree = await isTreeAvailable(request.user.directories);
        const group = useTree ? await touchGroupOwner(request.user.directories, { groupId: request.body?.group_id }) : null;

        if (group) {
            const raw = fs.readFileSync(pathToUpload, 'utf8');
            const chatData = raw.split('\n').map(line => tryParse(line)).filter(x => x);
            if (chatData.length === 0) {
                fs.unlinkSync(pathToUpload);
                console.error('Group chat import failed: the uploaded file held no parseable lines.');
                return response.send({ error: true });
            }

            const result = await saveChatToTree(request.user.directories, group.id, chatname, chatData, true);
            if (result) {
                fs.unlinkSync(pathToUpload);
                return response.send({ res: chatname });
            }
            // saveChatToTree returned null - fall through to the file write rather than losing the upload.
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

router.post('/import', validateAvatarUrlMiddleware, function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const format = request.body.file_type;
    const avatarUrl = (request.body.avatar_url).replace('.png', '');
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
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

        if (format === 'json') {
            fs.unlinkSync(pathToUpload);
            const jsonData = JSON.parse(data);

            /** @type {function(string, string, object): string|string[]} */
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

            const handleChat = (chat) => {
                const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
                const filePath = path.join(directoryPath, fileName);
                fileNames.push(fileName);
                writeFileAtomicSync(filePath, chat, 'utf8');
            };

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                chat.forEach(handleChat);
            } else {
                handleChat(chat);
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
            const filePath = path.join(directoryPath, fileName);
            fileNames.push(fileName);
            if (flattenedChat !== data) {
                writeFileAtomicSync(filePath, flattenedChat, 'utf8');
            } else {
                fs.copyFileSync(pathToUpload, filePath);
            }
            fs.unlinkSync(pathToUpload);
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

/**
 * Establishes which group a request is actually about, and guarantees that group's chats are in the tree
 * before the caller touches them.
 *
 * Every group route addresses a chat by the chat's own id and says nothing about the owner, while the tree
 * addresses everything by owner. Bridging that is one lookup, and it is the same lookup that produces the
 * file list migration needs (all groups' chats share one flat directory, so "this group's files" is a
 * statement only the group descriptor can make). Doing both here keeps the two from ever disagreeing about
 * which group a chat belongs to.
 *
 * The migrate-on-touch call is a precondition, not a question - see migrateOwnerOnTouch(). Callers use the
 * returned group to address the tree, never to decide whether to use it.
 *
 * @returns {Promise<{ id: string, chats: string[] } | null>} `null` when no group claims this chat, which is
 * a real answer and not a licence to guess: a chat with no owner has no address in the tree.
 */
async function touchGroupOwner(directories, { chatId, groupId }) {
    const group = resolveGroupOwner(directories.groups, { chatId, groupId });
    if (!group) return null;

    await migrateOwnerOnTouch(directories, {
        ownerId: group.id,
        chatDir: directories.groupChats,
        isGroup: true,
        fileNames: group.chats.map(c => `${c}.jsonl`),
    });
    return group;
}

router.post('/group/get', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = String(request.body.id);
        const useTree = await isTreeAvailable(request.user.directories);
        const group = useTree ? await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id }) : null;

        if (group) {
            // Same node-id-or-name resolution /get uses, for the same reason: a node id is exact, a label
            // is not unique per owner, and both have to keep working while the client moves over.
            const result = await loadAtNode(request.user.directories, group.id, id)
                ?? await loadBranch(request.user.directories, group.id, id);
            if (result) {
                /** @type {any} */
                const header = {
                    chat_metadata: { ...result.metadata, _tree_stored: true },
                    user_name: 'unused',
                    character_name: 'unused',
                };
                return response.send([header, ...result.messages]);
            }
            // A miss is an empty array here, NOT the 404 the character /get returns. The two routes have
            // genuinely different contracts: getGroupChat() reads an empty result as "this is a fresh chat"
            // and seeds it from the members' greetings, which is exactly right for a chat id the group just
            // minted and has never saved. Characters have doNewChat()'s isNewChat flag to make that same
            // distinction explicitly, so their route can afford to treat a miss as an error; groups don't.
            return response.send([]);
        }

        // No resolvable owner (or no tree at all). Reading the file is what this route has always done and
        // cannot corrupt anything, so an orphaned chat id still renders rather than silently coming back empty.
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        return response.send(getChatData(chatFilePath));
    } catch (error) {
        console.error(error);
        return response.send([]);
    }
});

/**
 * Every chat a group owns, in one call, the way /tree/branches answers it for a character.
 *
 * The per-chat /group/info below can still answer for a single chat, but a listing built out of it is one
 * request per chat and can only report chats the descriptor happens to name. A branch listing is one query
 * and reports what the store actually holds.
 */
router.post('/group/branches', async (request, response) => {
    try {
        if (!request.body || !request.body.group_id) {
            return response.sendStatus(400);
        }

        const groupId = String(request.body.group_id);
        const group = await touchGroupOwner(request.user.directories, { groupId });
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
            mes: b.last_mes || '[No messages]',
            // The branch's leaf, not its label's birthday - see branchViewSync().
            last_mes: b.last_activity ?? b.created_at,
            chat_metadata: request.body.metadata && b.metadata ? JSON.parse(b.metadata) : undefined,
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
        const useTree = await isTreeAvailable(request.user.directories);
        const group = useTree ? await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id }) : null;

        if (group) {
            const branch = (await listBranches(request.user.directories, group.id)).find(b => b.name === id);
            if (branch) {
                return response.send({
                    match: true,
                    file_id: branch.name,
                    file_name: `${branch.name}.jsonl`,
                    // Nothing meaningful to report for a chat that isn't a file. Reported as a formatted
                    // zero rather than omitted, so a caller rendering this field gets a string either way.
                    file_size: formatBytes(0),
                    chat_items: branch.message_count,
                    mes: branch.last_mes || '[The chat is empty]',
                    last_mes: branch.last_activity ?? branch.created_at,
                });
            }
            // Fall through: a chat id the descriptor names but the tree has never seen (never saved).
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const chatInfo = await getChatInfo(chatFilePath);
        return response.send(chatInfo);
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
        const useTree = await isTreeAvailable(request.user.directories);
        // The client drops the chat from the group's `chats` array before it calls this, so a chat-id scan
        // can no longer find the owner by the time the request lands - which is why group-chats.js sends
        // `group_id` explicitly on this route rather than relying on the reverse lookup.
        const group = useTree ? await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id }) : null;

        if (group && await deleteBranch(request.user.directories, group.id, id)) {
            // Unlabels the node; the messages and everything below them stay exactly where they are, same
            // as deleting a character's chat does. What's deleted is the name, not the history.
            return response.send({ ok: true });
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        if (tryDeleteFile(chatFilePath)) {
            await deleteChatRow(request.user.directories, chatFilePath).catch(err =>
                console.error('[chat-metadata] Failed to update chat metadata store after delete:', err));
            return response.send({ ok: true });
        }

        console.error('The group chat was not deleted.');
        return response.sendStatus(400);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/save', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = String(request.body.id);
        const handle = request.user.profile.handle;
        const chatData = request.body.chat;

        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }

        const useTree = await isTreeAvailable(request.user.directories);
        if (useTree) {
            const group = await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id });
            if (!group) {
                // Refused, not quietly written to a file. A chat whose owning group can't be established has
                // no address in the tree, and the JSONL it would land in is one nothing reads any more once
                // that group is tree-backed - the chat would look saved and be gone. The client surfaces this
                // as a save failure, which is the honest outcome.
                console.error(`Refusing to save group chat "${id}": no group claims it.`);
                return response.status(400).send({ error: 'unknown_group' });
            }

            const result = await saveChatToTree(request.user.directories, group.id, id, chatData, true);
            if (result) {
                // Groups-schema extension write-path hook (owner decision - see character-metadata-db.js's
                // bumpGroupChatStats() for the full rationale): keeps date_last_chat/chat_size fresh the
                // moment a chat is saved rather than only when the group's own JSON is rewritten. The stats
                // are handed over rather than derived, because the files they used to be derived from don't
                // exist for a tree-backed group - see that function's doc comment. Awaited but not fatal:
                // the chat write already succeeded, and a stats failure shouldn't turn that into an error.
                await bumpGroupChatStats(request.user.directories, id, {
                    groupId: group.id,
                    stats: { dateLastChat: Date.now(), chatSize: Buffer.byteLength(JSON.stringify(chatData), 'utf8') },
                }).catch(err => console.error(`Could not update group chat stats for ${id}:`, err));

                return response.send({
                    ok: true,
                    integrity: result.integrity,
                    assigned_node_ids: result.assignedNodeIds,
                });
            }
            // saveChatToTree returned null (backend went away between the check and the write) - fall through.
        }

        // JSONL fallback, for a globally unavailable tree backend. Not a per-group question.
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const integrity = await trySaveChat(chatData, chatFilePath, request.body.force, handle, id, request.user.directories.backups, request.user.directories);
        await bumpGroupChatStats(request.user.directories, id, { groupId: request.body.group_id }).catch(err =>
            console.error(`Could not update group chat stats for ${id}:`, err));

        return response.send({ ok: true, integrity });
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
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : [];

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        // Tree-migrated character path: branches replace JSONL files entirely. This has to run BEFORE the
        // JSONL directory scan below - a character whose chats live entirely in the tree DB (created after
        // tree storage became primary, or fully migrated with nothing left behind) never gets a
        // `directories.chats/<owner>` folder created on disk at all, so the JSONL branch's own
        // `fs.existsSync(directoryPath)` early-return used to fire unconditionally for every such
        // character - for every query, not just an empty one - and short-circuit out of this route before
        // the tree path ever got a chance to run. Confirmed live: 01a03228-a216-7454-b76f-e3e9704f28ef (a
        // tree-native character with 4 real branches, no chats/ folder on disk) returned `[]` from this
        // route for both an empty query and a real content query, while calling searchBranchesByContent()
        // directly against the same owner id returned all 4 branches correctly either way.
        //
        // Groups run the same path. They used to be excluded here on the grounds that group chats were
        // "always file-based", which stopped being true - and once their files are renamed away, the JSONL
        // scan below finds nothing and every group search silently returns no results. Only the owner id
        // differs, and for a group that means resolving it first (the request carries the group's id, so
        // this is one direct descriptor read, not a scan).
        if (avatar_url || group_id) {
            const treeMigrated = await isTreeAvailable(request.user.directories);
            const ownerId = group_id
                ? (await touchGroupOwner(request.user.directories, { groupId: String(group_id) }))?.id ?? null
                : String(avatar_url).replace('.png', '');

            if (treeMigrated && ownerId) {
                // Content search (or list-all when no query) via tree DB
                const branches = await searchBranchesByContent(request.user.directories, ownerId, fragments);

                if (branches !== null) {
                    let results = branches.map(b => ({
                        // The node this bookmark sits on. A name is not an identifier - `label` is
                        // not unique per owner - so the id is what opening one should use.
                        node_id: b.id,
                        file_name: b.name,
                        file_size: null,
                        message_count: b.message_count,
                        last_mes: b.leaf_send_date || '',
                        preview_message: getPreviewMessage(b.last_mes),
                    }));

                    // Also match branch names against the query (content search only covers message text)
                    if (query) {
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
                                        last_mes: b.leaf_send_date || '',
                                        preview_message: getPreviewMessage(b.last_mes),
                                    });
                                }
                            }
                        }
                    }

                    const total = results.length;
                    if (pageSize > 0) {
                        results = results.slice(page * pageSize, (page + 1) * pageSize);
                    }
                    return response.send(results);
                }
                // If searchBranchesByContent returned null (DB unavailable), fall through to JSONL logic
            }
        }

        // JSONL path, for a globally unavailable tree backend, or an owner the tree has nothing for.
        /** @type {string[]} */
        let chatFiles = [];

        if (group_id) {
            // Find group's chat IDs first
            const groupDir = path.join(request.user.directories.groups);
            const groupFiles = fs.readdirSync(groupDir)
                .filter(file => path.extname(file) === '.json');

            let targetGroup;
            for (const groupFile of groupFiles) {
                try {
                    const groupData = JSON.parse(fs.readFileSync(path.join(groupDir, groupFile), 'utf8'));
                    if (groupData.id === group_id) {
                        targetGroup = groupData;
                        break;
                    }
                } catch (error) {
                    console.warn(groupFile, 'group file is corrupted:', error);
                }
            }

            if (!Array.isArray(targetGroup?.chats)) {
                return response.send([]);
            }

            // Find group chat files for given group ID
            const groupChatsDir = path.join(request.user.directories.groupChats);
            chatFiles = targetGroup.chats
                .map(chatId => path.join(groupChatsDir, `${chatId}.jsonl`))
                .filter(fileName => fs.existsSync(fileName));
        } else if (avatar_url) {
            // Regular character chat directory
            const character_name = avatar_url.replace('.png', '');
            const directoryPath = path.join(request.user.directories.chats, character_name);

            if (!fs.existsSync(directoryPath)) {
                return response.send([]);
            }

            chatFiles = fs.readdirSync(directoryPath)
                .filter(file => path.extname(file) === '.jsonl')
                .map(fileName => path.join(directoryPath, fileName));
        }

        /**
         * @type {SearchChatResult[]}
         * @typedef {object} SearchChatResult
         * @property {string} [file_name] - The name of the chat file
         * @property {string} [file_size] - The size of the chat file in a human-readable format
         * @property {number} [message_count] - The number of messages in the chat
         * @property {number|string} [last_mes] - The timestamp of the last message
         * @property {string} [preview_message] - A preview of the last message
         */
        let results = [];

        if (query) {
            // Real content search: try the tantivy message index first (chat-content-search-index.js) - see
            // that module's own header for why it's the preferred path (no per-request full-file scan, real
            // relevance ranking) and why "tantivy unavailable" falls all the way back to the original
            // getChatInfo()+hasTextMatch scan below rather than returning a degraded/empty result.
            const contentSearch = await searchChatMessages(request.user.profile.handle, request.user.directories, query);

            if (contentSearch.backend !== 'unavailable') {
                const scopedFiles = new Set(chatFiles);
                // The old scan matched EITHER message content OR the chat's own filename (hasTextMatch() was run
                // against both) - the tantivy index only covers message content (filenames were never indexed),
                // so filename matches are computed here separately, same cheap in-memory check as before (no I/O
                // beyond the stat/cache lookup getOrComputeChatInfo() already does), and unioned with the content
                // hits below to keep that behavior.
                const contentMatches = contentSearch.results.filter(r => scopedFiles.has(r.file_path));
                const matchedFilePaths = new Set(contentMatches.map(r => r.file_path));

                for (const chatFile of chatFiles) {
                    if (matchedFilePaths.has(chatFile)) {
                        continue;
                    }
                    const fileId = path.parse(chatFile).name;
                    if (!hasTextMatch([fileId])) {
                        continue;
                    }
                    const stats = await fs.promises.stat(chatFile).catch(() => null);
                    if (!stats) {
                        continue;
                    }
                    const chatInfo = await getOrComputeChatInfo(request.user.directories, chatFile, stats.mtimeMs, {}, false);
                    if (!chatInfo.file_name) {
                        continue;
                    }
                    results.push({
                        file_name: chatInfo.file_id,
                        file_size: chatInfo.file_size,
                        message_count: chatInfo.chat_items,
                        last_mes: chatInfo.last_mes,
                        preview_message: getPreviewMessage(chatInfo.mes),
                    });
                }

                for (const match of contentMatches) {
                    results.push({
                        file_name: match.file_name,
                        file_size: match.file_size,
                        message_count: match.message_count,
                        last_mes: match.last_mes,
                        preview_message: getPreviewMessage(match.preview_message),
                    });
                }

                if (pageSize > 0) {
                    results = results.slice(page * pageSize, (page + 1) * pageSize);
                }
                return response.send(results);
            }
        }

        for (const chatFile of chatFiles) {
            let chatInfo;
            if (query) {
                // Tantivy unavailable on this install - the original full-file scan, unchanged.
                chatInfo = await getChatInfo(chatFile, {}, false, hasTextMatch);
            } else {
                // No query: this is pure listing, exactly the cost getOrComputeChatInfo() exists to avoid
                // paying on every request (see that function's own doc comment).
                const stats = await fs.promises.stat(chatFile).catch(() => null);
                if (!stats) {
                    continue;
                }
                chatInfo = await getOrComputeChatInfo(request.user.directories, chatFile, stats.mtimeMs, {}, false);
            }
            const hasMatch = chatInfo.match || hasTextMatch([chatInfo.file_id ?? '']);

            // Skip corrupted or invalid chat files
            if (!chatInfo.file_name) {
                continue;
            }

            // Empty chats without a file name match are skipped when searching with a query
            if (query && chatInfo.chat_items === 0 && !hasMatch) {
                continue;
            }

            // If no search query or a match was found, include the chat in results
            if (!query || hasMatch) {
                results.push({
                    file_name: chatInfo.file_id,
                    file_size: chatInfo.file_size,
                    message_count: chatInfo.chat_items,
                    last_mes: chatInfo.last_mes,
                    preview_message: getPreviewMessage(chatInfo.mes),
                });
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
        /** @typedef {{pngFile?: string, groupId?: string, filePath: string, mtime: number, branch?: object}} ChatFile */
        /** @type {ChatFile[]} */
        const allChatFiles = [];
        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];
        const max = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER) + pinnedChats.length;

        // Tree-stored chats have no file to stat. They are branches, and how recent one is means
        // when it was last spoken in - the file scans below still run, and simply find nothing for
        // any character whose chats have already moved into the tree.
        const getTreeBranches = async () => {
            for (const branch of await listRecentBranches(request.user.directories, max)) {
                // An owner id is a character avatar for one kind of owner and a group's id for the other,
                // and gluing '.png' onto it unconditionally turned every group's chats into entries for a
                // character that does not exist. The store already records which kind it is.
                allChatFiles.push({
                    ...(branch.is_group ? { groupId: branch.owner_id } : { pngFile: `${branch.owner_id}.png` }),
                    filePath: `${branch.name}.jsonl`,
                    mtime: branch.last_activity ?? branch.created_at,
                    branch,
                });
            }
        };

        const treeChatInfo = (branch, withMetadata) => ({
            node_id: branch.id,
            file_name: `${branch.name}.jsonl`,
            ...(branch.is_group ? { group: branch.owner_id } : { avatar: `${branch.owner_id}.png` }),
            file_size: 0,
            chat_items: branch.message_count,
            mes: branch.last_mes || '[No messages]',
            last_mes: branch.last_activity ?? branch.created_at,
            chat_metadata: withMetadata && branch.metadata ? JSON.parse(branch.metadata) : undefined,
        });

        const getCharacterChatFiles = async () => {
            const pngDirents = await fs.promises.readdir(request.user.directories.characters, { withFileTypes: true });
            const pngFiles = pngDirents.filter(e => e.isFile() && path.extname(e.name) === '.png').map(e => e.name);

            for (const pngFile of pngFiles) {
                const chatsDirectory = pngFile.replace('.png', '');
                const pathToChats = path.join(request.user.directories.chats, chatsDirectory);
                if (!fs.existsSync(pathToChats)) {
                    continue;
                }
                const pathStats = await fs.promises.stat(pathToChats);
                if (pathStats.isDirectory()) {
                    const chatFiles = await fs.promises.readdir(pathToChats);
                    const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');

                    for (const file of jsonlFiles) {
                        const filePath = path.join(pathToChats, file);
                        const stats = await fs.promises.stat(filePath);
                        allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
                    }
                }
            }
        };

        const getGroupChatFiles = async () => {
            const groupDirents = await fs.promises.readdir(request.user.directories.groups, { withFileTypes: true });
            const groups = groupDirents.filter(e => e.isFile() && path.extname(e.name) === '.json').map(e => e.name);

            for (const group of groups) {
                try {
                    const groupPath = path.join(request.user.directories.groups, group);
                    const groupContents = await fs.promises.readFile(groupPath, 'utf8');
                    const groupData = JSON.parse(groupContents);

                    if (Array.isArray(groupData.chats)) {
                        for (const chat of groupData.chats) {
                            const filePath = path.join(request.user.directories.groupChats, `${chat}.jsonl`);
                            if (!fs.existsSync(filePath)) {
                                continue;
                            }
                            const stats = await fs.promises.stat(filePath);
                            allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                        }
                    }
                } catch (error) {
                    // Skip group files that can't be read or parsed
                    continue;
                }
            }
        };

        const getRootChatFiles = async () => {
            const dirents = await fs.promises.readdir(request.user.directories.chats, { withFileTypes: true });
            const chatFiles = dirents.filter(e => e.isFile() && path.extname(e.name) === '.jsonl').map(e => e.name);

            for (const file of chatFiles) {
                const filePath = path.join(request.user.directories.chats, file);
                const stats = await fs.promises.stat(filePath);
                allChatFiles.push({ filePath, mtime: stats.mtimeMs });
            }
        };

        await Promise.allSettled([getTreeBranches(), getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]);

        const isPinned = (/** @type {ChatFile} */ chatFile) => pinnedChats.some(p => p.file_name === path.basename(chatFile.filePath) && (p.avatar === chatFile.pngFile || p.group === chatFile.groupId));
        const recentChats = allChatFiles.sort((a, b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

            return b.mtime - a.mtime;
        }).slice(0, max);
        const jsonFilesPromise = recentChats.map((file) => {
            const withMetadata = !!request.body.metadata;
            if (file.branch) {
                return Promise.resolve(treeChatInfo(file.branch, withMetadata));
            }
            return file.groupId
                ? getOrComputeChatInfo(request.user.directories, file.filePath, file.mtime, { group: file.groupId }, withMetadata)
                : getOrComputeChatInfo(request.user.directories, file.filePath, file.mtime, { avatar: file.pngFile }, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
