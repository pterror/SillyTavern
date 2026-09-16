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
import { bumpCharacterDateLastChat, bumpGroupChatStats, getCharacterActiveChatsByIds, setCharacterActiveChat } from '../character-metadata-db.js';
import { resolveGroupOwner } from '../character-shallow.js';
import { readGroupFile, writeGroupFile } from './groups.js';
import { readCardContent } from './characters.js';
import { cardToGreetingsModel } from '../greeting-list.js';
import { migrateOwnerOnTouch } from '../message-tree-migration.js';
import { upsertChatFromSave, upsertChatFromParse, getChatRow, deleteChatRow, renameChatRow } from '../chat-metadata-db.js';
import { searchChatMessages } from './chat-content-search-index.js';
import {
    isAvailable as isTreeAvailable, hasSavedChats,
    saveChatToTree, loadBranch, forkBranch, labelNode,
    deleteBranch, renameBranch as renameBranchInTree, listBranches, listRecentBranches, searchBranchesByContent,
    renameCharacterInMessages, renameGroupMemberInMessages, getAlternatives, getContinuation, getAncestorPath, editMessage, editMessages, appendMessages, addAlternatives, setChatMetadata, getOpeningAlternatives, addOpeningAlternatives, loadAtNode, listLabels, setNodeMetadata, selectDefaultChild, endPathAt, endPathAtAnchor, graftMessage, degraftRange, swapAdjacent, deleteAlternative,
} from '../message-tree-db.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';

/** Non-ASCII names would otherwise all collapse to the same sanitized key; a hash suffix keeps them distinct. */
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
 * Keyed per user and chat, so rapid saves in one chat can't swallow the throttled backup of another.
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

    // A non-parsing first line means the file may be corrupted/truncated - fail so the client confirms the overwrite.
    if (typeof jsonData !== 'object' || jsonData === null || Array.isArray(jsonData)) {
        console.warn(`File "${filePath}" is not empty, but its first line could not be parsed as a chat header. Overwriting it requires an explicit confirmation.`);
        return false;
    }

    const chatIntegrity = jsonData?.chat_metadata?.integrity;

    // If the chat has no integrity metadata, assume it's intact (legacy chats created before integrity checks existed)
    if (!chatIntegrity) {
        return true;
    }

    // Check if the integrity matches
    const matches = chatIntegrity === integritySlug;

    if (!matches) {
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

/**
 * Cache-first counterpart to getChatInfo(): serves a chat's info from the metadata row when its mtime still
 * matches, else falls back to a full parse (caching the result). A cached row only holds the last message's
 * preview, not full text, so callers needing a content `matcher` must call getChatInfo() directly.
 * @param {number} mtimeMs The file's current mtime, already known by the caller
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

    // Not awaited, so a cache miss doesn't pay for the write on top of the parse it just did.
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
 * Also rotates the integrity slug on every successful write (when tracking is enabled), writes it into the
 * saved file, and returns it to the caller, which must feed it into that tab's next save. Otherwise the slug
 * never diverges from what any tab that ever loaded the chat is sending, and the check can never catch a stale
 * write from another tab.
 * @param {boolean} skipIntegrityCheck If undefined, the chat's integrity will not be checked.
 * @param {import('../users.js').UserDirectoryList} [directories] When given, updates the chat metadata store
 * right after the write succeeds. Optional since not every caller has directories to offer.
 * @returns {Promise<string|undefined>} The new integrity slug written to the file, or undefined if integrity
 * tracking is disabled or the chat has no header to carry a slug.
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

/**
 * Picks a filename that doesn't already exist on disk, for callers that only have a desired base name
 * (e.g. "Some Chat") and want the server - not a client-fetched directory listing - to be the source of
 * truth for uniqueness. Mirrors labelNode()'s "<name> - Branch #N" scheme so branch names look the same
 * whether the chat is tree-stored or still a legacy JSONL file.
 * @param {string} chatDir Directory the chat file would be written into.
 * @param {string} baseName Desired chat name, without extension.
 * @returns {string} `baseName` unchanged if free, otherwise `<baseName> - Branch #N` for the first free N.
 */
function pickUniqueChatFileName(chatDir, baseName) {
    const exists = (name) => fs.existsSync(path.join(chatDir, sanitize(`${name}.jsonl`)));
    if (!exists(baseName)) {
        return baseName;
    }
    const cleanBase = String(baseName).replace(/ - Branch #\d+$/, '');
    let i = 1;
    while (exists(`${cleanBase} - Branch #${i}`)) i++;
    return `${cleanBase} - Branch #${i}`;
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        let chatName = String(request.body.file_name);

        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }

        // Whole-array save: our own frontend uses this on the normal path too (a fresh chat's first
        // save, and tree-chat snapshots), alongside the named per-row operations for everything else.
        await migrateOwnerOnTouch(request.user.directories, {
            ownerId: cardName,
            chatDir: path.join(request.user.directories.chats, cardName),
        });

        // A fresh branch/bookmark save asks for a name minted here (like /chats/label's unique:true)
        // instead of asserting a name the client uniquified against its own fetched chat list.
        if (request.body.unique) {
            chatName = pickUniqueChatFileName(path.join(request.user.directories.chats, cardName), chatName);
        }

        const result = await saveChatToTree(request.user.directories, cardName, chatName, chatData, false);
        if (result) {
            await bumpCharacterDateLastChat(request.user.directories, String(request.body.avatar_url)).catch(err =>
                console.error(`Could not bump date_last_chat for ${cardName}:`, err));
            return response.send({
                ok: true,
                integrity: result.integrity,
                assigned_node_ids: result.assignedNodeIds,
                file_name: chatName,
            });
        }

        // saveChatToTree only returns null for an empty chatData array; everything else lands above.
        const chatFileName = `${sanitize(chatName)}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        const integrity = await trySaveChat(chatData, chatFilePath, request.body.force, handle, cardName, request.user.directories.backups, request.user.directories);
        await bumpCharacterDateLastChat(request.user.directories, String(request.body.avatar_url)).catch(err =>
            console.error(`Could not bump date_last_chat for ${cardName}:`, err));
        return response.send({ ok: true, integrity, file_name: chatName });
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

        if (chatName) {
            // Opening a chat is a touch too, or a never-migrated character renders blank on first read.
            await migrateOwnerOnTouch(request.user.directories, {
                ownerId: dirName,
                chatDir: path.join(request.user.directories.chats, dirName),
            });
            // The pointer may be a node id (exact) or a legacy chat name (looked up, not unique per owner);
            // both are accepted so an existing pointer keeps working while the client moves over.
            const result = await loadAtNode(request.user.directories, dirName, chatName)
                ?? await loadBranch(request.user.directories, dirName, chatName);
            if (result) {
                // _tree_stored flag lets the client use tree-specific APIs (fork, label)
                /** @type {any} */
                const header = {
                    chat_metadata: { ...result.metadata, _tree_stored: true },
                    user_name: 'unused',
                    character_name: 'unused',
                };
                return response.send([header, ...result.messages]);
            }
            // A 404 (rather than {}) here lets the client distinguish "stale pointer to a gone chat" from
            // a legitimately new/unsaved chat and trigger recovery instead of silently rendering blank.
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

        // `avatar_url` means nothing for a group; its owner is resolved from the chat being renamed instead.
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

        const activeChats = await getCharacterActiveChatsByIds(request.user.directories, [dirName]);
        const wasActiveChat = activeChats[dirName] === chatName;

        // Tree DB path
        if (await hasSavedChats(request.user.directories, dirName)) {
            const deleted = await deleteBranch(request.user.directories, dirName, chatName);
            if (!deleted) {
                return response.sendStatus(400);
            }
            if (!wasActiveChat) {
                return response.send({ ok: true });
            }
            // Same recency measure listRecentBranches() already sorts by: last_activity (a branch's
            // leaf message), falling back to the label's own creation time for a branch with no
            // activity of its own yet.
            const remaining = await listBranches(request.user.directories, dirName);
            remaining.sort((a, b) => (b.last_activity ?? b.created_at ?? 0) - (a.last_activity ?? a.created_at ?? 0));
            const activeChat = remaining.length ? remaining[0].id : null;
            await setCharacterActiveChat(request.user.directories, dirName, activeChat);
            return response.send({ ok: true, activeChat: activeChat ?? '' });
        }

        // JSONL fallback
        const chatFileName = String(request.body.chatfile);
        const chatFilePath = path.join(request.user.directories.chats, dirName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }
        if (!tryDeleteFile(chatFilePath)) {
            console.error('The chat file was not deleted.');
            return response.sendStatus(400);
        }
        await deleteChatRow(request.user.directories, chatFilePath).catch(err =>
            console.error('[chat-metadata] Failed to update chat metadata store after delete:', err));

        if (!wasActiveChat) {
            return response.send({ ok: true });
        }

        const chatsDirectory = path.join(request.user.directories.chats, dirName);
        let remainingFiles = [];
        try {
            remainingFiles = fs.readdirSync(chatsDirectory, { withFileTypes: true })
                .filter(file => file.isFile() && path.extname(file.name) === '.jsonl')
                .map(file => file.name);
        } catch (err) {
            console.error('[chats/delete] Failed to list remaining chats after delete:', err);
        }
        // File mtime, the same recency measure a fresh JSONL chat list is otherwise sorted by client-side.
        const remainingWithMtime = (await Promise.allSettled(remainingFiles.map(async file => {
            const stats = await fs.promises.stat(path.join(chatsDirectory, file));
            return { file, mtimeMs: stats.mtimeMs };
        }))).filter(x => x.status === 'fulfilled').map(x => x.value);
        remainingWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const activeChat = remainingWithMtime.length ? path.parse(remainingWithMtime[0].file).name : null;
        await setCharacterActiveChat(request.user.directories, dirName, activeChat);
        return response.send({ ok: true, activeChat: activeChat ?? '' });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
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

/** The conversation below a node, for moving onto a different alternative's path. */
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
//  Per-row operations a save is made of, replacing handing the whole conversation over each time.
// ---------------------------------------------------------------------------

/**
 * Which owner an operation is against: a character by avatar, or a group by its own id (a group has no
 * avatar). No migration precondition here - these routes act on a row the client already holds, which it
 * can only hold because a load (which runs migrate-on-touch) put it there.
 */
const ownerOf = (request) => (request.body.group_id
    ? String(request.body.group_id)
    : String(request.body.avatar_url).replace('.png', ''));

/** Bumps whichever "last active" stat this op's owner actually has - a character's date_last_chat, or a group's (which also restats chat_size, so it's never handed a raw byte count here). */
const bumpOwnerLastChat = (directories, request) => (request.body.group_id
    ? bumpGroupChatStats(directories, null, { groupId: String(request.body.group_id) })
    : bumpCharacterDateLastChat(directories, String(request.body.avatar_url)));

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

/** Appends one or more messages after a node. */
router.post('/message/append', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const after = String(request.body.after_node_id || '');
        if (!after) return response.status(400).send({ error: 'after_node_id is required' });

        const contents = Array.isArray(request.body.messages) ? request.body.messages : [];
        const result = await appendMessages(request.user.directories, ownerOf(request), after, contents);

        if (result.ok && contents.length) {
            await bumpOwnerLastChat(request.user.directories, request).catch(err =>
                console.error('Could not bump date_last_chat:', err));
        }

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
 * @returns {Promise<object[]>} Empty array if the character can't be read.
 */
async function _cardGreetingsFromDisk(directories, avatar) {
    try {
        const avatarPath = path.join(directories.characters, avatar);
        // readCardContent(), not readCharacterData(): a greeting edit is persisted to the metadata db
        // without rewriting the PNG, so reading the file directly could show stale greetings.
        const pngStringData = await readCardContent(directories, avatar, avatarPath);
        if (!pngStringData) return [];
        const character = JSON.parse(pngStringData);
        const { greetings } = cardToGreetingsModel(character);
        const speaker = character?.name ?? character?.data?.name ?? '';
        const sendDate = Date.now();
        return (greetings ?? [])
            .filter(text => typeof text === 'string' && text.length > 0)
            .map(text => ({ name: speaker, is_user: false, is_system: false, send_date: sendDate, mes: text, extra: {} }));
    } catch (error) {
        console.error(`Error reading card greetings for "${avatar}":`, error);
        return [];
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
        const avatar = String(request.body.avatar_url || '');
        // Group chats have no single card to read greetings off of.
        const cardGreetings = avatar ? await _cardGreetingsFromDisk(request.user.directories, avatar) : [];
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
            const ok = await endPathAtAnchor(request.user.directories, ownerOf(request));
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

/** Inserts a new node between two adjacent nodes — the mid-chain-insert primitive (a user-typed message spliced into the middle of a chain, not appended at the end). */
router.post('/message/graft', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const after = String(request.body.after_node_id || '');
        if (!after) return response.status(400).send({ error: 'after_node_id is required' });
        const before = String(request.body.before_node_id || '');
        if (!before) return response.status(400).send({ error: 'before_node_id is required' });

        const result = await graftMessage(request.user.directories, ownerOf(request), after, before, request.body.content);

        if (result.ok) {
            await bumpOwnerLastChat(request.user.directories, request).catch(err =>
                console.error('Could not bump date_last_chat:', err));
        }

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

    const ownerId = request.body.is_group ? null : String(request.body.avatar_url).replace('.png', '');
    const chatName = String(request.body.file).replace(/\.jsonl$/, '');
    const exportfilename = request.body.exportfilename;

    // Tree DB path: generates JSONL from tree data on demand.
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

        // Once a group is in the tree, an import must go through the store too, or the file it drops is
        // never read again. touchGroupOwner() must run before the import to migrate any file-backed
        // history first - migrating after would strand it behind the import's own label.
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
 * Resolves which group owns a chat/group id and migrates its chats into the tree before the caller touches
 * them.
 * @returns {Promise<{ id: string, chats: string[] } | null>} `null` when no group claims this chat.
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
        const group = await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id });

        if (group) {
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
            // Empty array, not the 404 character /get returns: getGroupChat() reads a miss as "fresh chat"
            // and seeds it from member greetings, which groups have no isNewChat flag to signal otherwise.
            return response.send([]);
        }

        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        return response.send(getChatData(chatFilePath));
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
        const group = await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id });

        if (group) {
            const branch = (await listBranches(request.user.directories, group.id)).find(b => b.name === id);
            if (branch) {
                return response.send({
                    match: true,
                    file_id: branch.name,
                    file_name: `${branch.name}.jsonl`,
                    file_size: formatBytes(0),
                    chat_items: branch.message_count,
                    mes: branch.last_mes || '[The chat is empty]',
                    last_mes: branch.last_activity ?? branch.created_at,
                });
            }
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
        // The client already dropped this chat from the group's `chats` array, so a chat-id scan can no
        // longer find the owner - group_id is sent explicitly instead.
        const group = await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id });

        if (group && await deleteBranch(request.user.directories, group.id, id)) {
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

/**
 * Same idea as pickUniqueChatFileName(), but for group chats: uniqueness is checked against the group's
 * own `chats` id list (already loaded via touchGroupOwner()) instead of a directory listing, since a
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
 * `{id, chats}` view from `resolveGroupOwner()`/`touchGroupOwner()`, so the full descriptor is re-read
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
    const fullGroup = readGroupFile(directories, group.id);
    if (!fullGroup) {
        return;
    }
    fullGroup.chats = Array.isArray(fullGroup.chats) ? [...fullGroup.chats, chatId] : [chatId];
    await writeGroupFile(directories, fullGroup);
}

/**
 * Fills in `extra.gen_id` for character messages missing one before a group chat is written to disk.
 * Group regeneration/swipe tracking depends on every character message carrying *some* gen_id; minting
 * the fallback here means callers that hand the server a whole chat array in one request (e.g. converting
 * a solo chat to a group) don't need to fabricate one client-side. A message that already has a gen_id -
 * real prior generation data - is left untouched; only messages missing one are filled in, with a value
 * that only needs to be unique within this one save (mirrors the old client-side `Date.now() + index`).
 * @param {Array<object>} chatData Chat array as posted to /group/save, i.e. [header, ...messages].
 */
function assignMissingGenIds(chatData) {
    const baseId = Date.now();
    for (let index = 1; index < chatData.length; index++) {
        const message = chatData[index];
        if (!message || message.is_user || message.is_system) {
            continue;
        }
        if (message.extra && typeof message.extra === 'object' && (message.extra.gen_id !== undefined && message.extra.gen_id !== null)) {
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
        const handle = request.user.profile.handle;
        const chatData = request.body.chat;

        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }

        assignMissingGenIds(chatData);

        const group = await touchGroupOwner(request.user.directories, { chatId: id, groupId: request.body.group_id });
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
        if (result) {
            await bumpGroupChatStats(request.user.directories, id, {
                groupId: group.id,
                stats: { dateLastChat: Date.now(), chatSize: Buffer.byteLength(JSON.stringify(chatData), 'utf8') },
            }).catch(err => console.error(`Could not update group chat stats for ${id}:`, err));
            await registerGroupChatIdIfNew(request.user.directories, group, id).catch(err =>
                console.error(`Could not register new chat id "${id}" on group ${group.id}:`, err));

            return response.send({
                ok: true,
                integrity: result.integrity,
                assigned_node_ids: result.assignedNodeIds,
                chat_id: id,
            });
        }

        // saveChatToTree only returns null for an empty chatData array.
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const integrity = await trySaveChat(chatData, chatFilePath, request.body.force, handle, id, request.user.directories.backups, request.user.directories);
        await bumpGroupChatStats(request.user.directories, id, { groupId: request.body.group_id }).catch(err =>
            console.error(`Could not update group chat stats for ${id}:`, err));
        await registerGroupChatIdIfNew(request.user.directories, group, id).catch(err =>
            console.error(`Could not register new chat id "${id}" on group ${group.id}:`, err));

        return response.send({ ok: true, integrity, chat_id: id });
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

        // Must run before the JSONL directory scan below: a fully tree-migrated character/group has no
        // `chats/<owner>` folder on disk at all, so that scan's existsSync() would otherwise short-circuit
        // this route to an empty result before the tree path gets a chance to run.
        if (avatar_url || group_id) {
            const treeMigrated = await isTreeAvailable(request.user.directories);
            const ownerId = group_id
                ? (await touchGroupOwner(request.user.directories, { groupId: String(group_id) }))?.id ?? null
                : String(avatar_url).replace('.png', '');

            if (treeMigrated && ownerId) {
                const branches = await searchBranchesByContent(request.user.directories, ownerId, fragments);

                if (branches !== null) {
                    let results = branches.map(b => ({
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
            // Tries the tantivy message index first; falls back to the full-file scan below if unavailable.
            const contentSearch = await searchChatMessages(request.user.profile.handle, request.user.directories, query);

            if (contentSearch.backend !== 'unavailable') {
                const scopedFiles = new Set(chatFiles);
                // The index only covers message content, not filenames, so filename matches are still
                // computed separately here and unioned with the content hits.
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
                chatInfo = await getChatInfo(chatFile, {}, false, hasTextMatch);
            } else {
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

        const getTreeBranches = async () => {
            for (const branch of await listRecentBranches(request.user.directories, max)) {
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
