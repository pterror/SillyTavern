import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync, default as writeFileAtomic } from 'write-file-atomic';

import { color, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { upsertGroupRow, deleteGroupRow } from '../character-metadata-db.js';
import { calculateGroupChatStats } from '../character-shallow.js';

export const router = express.Router();

/**
 * Warns if group data contains deprecated metadata keys and removes them.
 * @param {object} groupData Group data object
 */
function warnOnGroupMetadata(groupData) {
    if (typeof groupData !== 'object' || groupData === null) {
        return;
    }
    ['chat_metadata', 'past_metadata'].forEach(key => {
        if (Object.hasOwn(groupData, key)) {
            console.warn(color.yellow(`Group JSON data for "${groupData.id}" contains deprecated key "${key}".`));
            delete groupData[key];
        }
    });
}

/**
 * Migrates group metadata to include chat metadata for each group chat instead of the group itself.
 * @param {import('../users.js').UserDirectoryList[]} userDirectories Listing of all users' directories
 */
export async function migrateGroupChatsMetadataFormat(userDirectories) {
    for (const userDirs of userDirectories) {
        try {
            let anyDataMigrated = false;
            const backupPath = path.join(userDirs.backups, '_group_metadata_update');
            const groupFiles = await fsPromises.readdir(userDirs.groups, { withFileTypes: true });
            const groupChatFiles = await fsPromises.readdir(userDirs.groupChats, { withFileTypes: true });
            for (const groupFile of groupFiles) {
                try {
                    const isJsonFile = groupFile.isFile() && path.extname(groupFile.name) === '.json';
                    if (!isJsonFile) {
                        continue;
                    }
                    const groupFilePath = path.join(userDirs.groups, groupFile.name);
                    const groupDataRaw = await fsPromises.readFile(groupFilePath, 'utf8');
                    const groupData = tryParse(groupDataRaw) || {};
                    const needsMigration = ['chat_metadata', 'past_metadata'].some(key => Object.hasOwn(groupData, key));
                    if (!needsMigration) {
                        continue;
                    }
                    if (!fs.existsSync(backupPath)) {
                        await fsPromises.mkdir(backupPath, { recursive: true });
                    }
                    await fsPromises.copyFile(groupFilePath, path.join(backupPath, groupFile.name));
                    const allMetadata = {
                        ...(groupData.past_metadata || {}),
                        [groupData.chat_id]: (groupData.chat_metadata || {}),
                    };
                    if (!Array.isArray(groupData.chats)) {
                        console.warn(color.yellow(`Group ${groupFile.name} has no chats array, skipping migration.`));
                        continue;
                    }
                    for (const chatId of groupData.chats) {
                        try {
                            const chatFileName = sanitize(`${chatId}.jsonl`);
                            const chatFileDirent = groupChatFiles.find(f => f.isFile() && f.name === chatFileName);
                            if (!chatFileDirent) {
                                console.warn(color.yellow(`Group chat file ${chatId} not found, skipping migration.`));
                                continue;
                            }
                            const chatFilePath = path.join(userDirs.groupChats, chatFileName);
                            const chatMetadata = allMetadata[chatId] || {};
                            const chatDataRaw = await fsPromises.readFile(chatFilePath, 'utf8');
                            const chatData = chatDataRaw.split('\n').filter(line => line.trim()).map(line => tryParse(line)).filter(Boolean);
                            const alreadyHasMetadata = chatData.length > 0 && Object.hasOwn(chatData[0], 'chat_metadata');
                            if (alreadyHasMetadata) {
                                console.log(color.yellow(`Group chat ${chatId} already has chat metadata, skipping update.`));
                                continue;
                            }
                            await fsPromises.copyFile(chatFilePath, path.join(backupPath, chatFileName));
                            const chatHeader = { chat_metadata: chatMetadata, user_name: 'unused', character_name: 'unused' };
                            const newChatData = [chatHeader, ...chatData];
                            const newChatDataRaw = newChatData.map(entry => JSON.stringify(entry)).join('\n');
                            await writeFileAtomic(chatFilePath, newChatDataRaw, 'utf8');
                            console.log(`Updated group chat data format for ${chatId}`);
                            anyDataMigrated = true;
                        } catch (chatError) {
                            console.error(color.red(`Could not update existing chat data for ${chatId}`), chatError);
                        }
                    }
                    delete groupData.chat_metadata;
                    delete groupData.past_metadata;
                    await writeFileAtomic(groupFilePath, JSON.stringify(groupData, null, 4), 'utf8');
                    console.log(`Migrated group chats metadata for group: ${groupData.id}`);
                    anyDataMigrated = true;
                } catch (groupError) {
                    console.error(color.red(`Could not process group file ${groupFile.name}`), groupError);
                }
            }
            if (anyDataMigrated) {
                console.log(color.green(`Completed migration of group chats metadata for user at ${userDirs.root}`));
                console.log(color.cyan(`Backups of modified files are located at ${backupPath}`));
            }
        } catch (directoryError) {
            console.error(color.red(`Error migrating group chats metadata for user at ${userDirs.root}`), directoryError);
        }
    }
}

/**
 * Reads all of a user's groups from disk, with the same date_added/date_last_chat/chat_size stats attached
 * that the `/all` route has always computed. Factored out so other endpoints (the characters/groups merge used
 * by paginated list requests, the group search index) can get the same data without an HTTP round trip.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object[]} Group objects
 */
export function getGroupsData(directories) {
    const groups = [];

    if (!fs.existsSync(directories.groups)) {
        fs.mkdirSync(directories.groups);
    }

    const files = fs.readdirSync(directories.groups).filter(x => path.extname(x) === '.json');

    files.forEach(function (file) {
        try {
            const filePath = path.join(directories.groups, file);
            const fileContents = fs.readFileSync(filePath, 'utf8');
            const group = JSON.parse(fileContents);
            const groupStat = fs.statSync(filePath);
            group.date_added = groupStat.birthtimeMs;
            group.create_date = new Date(groupStat.birthtimeMs).toISOString();

            // Shared with character-metadata-db.js's bumpGroupChatStats()/bootstrapGroupsIfNeeded() - see that
            // function's own doc comment (character-shallow.js). Stats only this group's own chat ids by name,
            // rather than the old inline version's readdir-then-filter-by-membership over the whole groupChats
            // directory.
            const { chatSize, dateLastChat } = calculateGroupChatStats(directories.groupChats, group.chats);
            group.date_last_chat = dateLastChat;
            group.chat_size = chatSize;
            groups.push(group);
        } catch (error) {
            console.error(error);
        }
    });

    return groups;
}

/**
 * Reads just the given group ids' JSON files off disk - the lean, bounded-by-`ids.length` counterpart to
 * getGroupsData()'s full-directory listing, for hydrating one page of a merged characters+groups `/query` result
 * (owner decision, extending the character-data-residency-redesign to groups) without a directory-wide read.
 *
 * Deliberately does NOT attach date_added/date_last_chat/chat_size/fav the way getGroupsData() does - those come
 * from the SQLite metadata row that already decided the page's sort order (see character-metadata-db.js's
 * queryEntities()), and re-deriving them here from a live stat would risk them disagreeing with the value the
 * page was actually sorted by. The `/query` route stamps the metadata row's values onto the object this returns.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]} ids Group ids to read
 * @returns {Record<string, object>} Keyed by group id - an id with no readable/parseable file is simply absent,
 * not an error (same tolerance getGroupsData()'s per-file try/catch already has).
 */
export function getGroupsByIds(directories, ids) {
    /** @type {Record<string, object>} */
    const result = {};
    for (const id of ids) {
        try {
            const filePath = path.join(directories.groups, sanitize(`${id}.json`));
            if (!fs.existsSync(filePath)) continue;
            const fileContents = fs.readFileSync(filePath, 'utf8');
            result[id] = JSON.parse(fileContents);
        } catch (error) {
            console.error(error);
        }
    }
    return result;
}

router.post('/all', (request, response) => {
    return response.send(getGroupsData(request.user.directories));
});

router.post('/create', async (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    warnOnGroupMetadata(request.body);
    const id = String(Date.now());
    const groupMetadata = {
        id: id,
        name: request.body.name ?? 'New Group',
        members: request.body.members ?? [],
        avatar_url: request.body.avatar_url,
        allow_self_responses: !!request.body.allow_self_responses,
        activation_strategy: request.body.activation_strategy ?? 0,
        generation_mode: request.body.generation_mode ?? 0,
        disabled_members: request.body.disabled_members ?? [],
        fav: request.body.fav,
        chat_id: request.body.chat_id ?? id,
        chats: request.body.chats ?? [id],
        auto_mode_delay: request.body.auto_mode_delay ?? 5,
        generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
        generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
    };
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(groupMetadata, null, 4);

    if (!fs.existsSync(request.user.directories.groups)) {
        fs.mkdirSync(request.user.directories.groups);
    }

    writeFileAtomicSync(pathToFile, fileData);

    // Phase 3 write-path hook (owner decision - see character-metadata-db.js's header): keeps the `groups`
    // table current so a tag assign/unassign against this id (src/endpoints/tags.js) has something to resolve
    // existence against. Awaited but not fatal to the request if it fails - same tolerance characters.js's own
    // hooks use elsewhere (see e.g. its /rename route), since the metadata store is a derived index, not the
    // group's own source of truth (the JSON file just written is).
    await upsertGroupRow(request.user.directories, groupMetadata.id, groupMetadata.name, { fav: groupMetadata.fav }).catch(err =>
        console.error(`Could not update group metadata store for ${groupMetadata.id}:`, err));

    return response.send(groupMetadata);
});

router.post('/edit', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }
    warnOnGroupMetadata(request.body);
    const id = request.body.id;
    const pathToFile = path.join(request.user.directories.groups, sanitize(`${id}.json`));
    const fileData = JSON.stringify(request.body, null, 4);

    writeFileAtomicSync(pathToFile, fileData);

    // Same phase 3 write-path hook as /create above - a group's name/fav can change here.
    await upsertGroupRow(request.user.directories, id, request.body.name, { fav: request.body.fav }).catch(err =>
        console.error(`Could not update group metadata store for ${id}:`, err));

    return response.send({ ok: true });
});

router.post('/delete', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const pathToGroup = path.join(request.user.directories.groups, sanitize(`${id}.json`));

    try {
        // Delete group chats
        const group = JSON.parse(fs.readFileSync(pathToGroup, 'utf8'));

        if (group && Array.isArray(group.chats)) {
            for (const chat of group.chats) {
                console.info('Deleting group chat', chat);
                const pathToFile = path.join(request.user.directories.groupChats, sanitize(`${chat}.jsonl`));

                if (fs.existsSync(pathToFile)) {
                    fs.unlinkSync(pathToFile);
                }
            }
        }
    } catch (error) {
        console.error('Could not delete group chats. Clean them up manually.', error);
    }

    if (fs.existsSync(pathToGroup)) {
        fs.unlinkSync(pathToGroup);
    }

    // Phase 3 write-path hook: removes the group's row and cascades to its tag assignments (see
    // deleteGroupRow()'s own doc comment) - without this, a deleted group's tags would linger in group_tags
    // forever (and its tag_usage counts would stay inflated), the same class of leak deleteCharacterRow()
    // already guards against for characters.
    await deleteGroupRow(request.user.directories, id).catch(err =>
        console.error(`Could not remove group metadata store row for ${id}:`, err));

    return response.send({ ok: true });
});
