import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync, default as writeFileAtomic } from 'write-file-atomic';

import { color, tryParse } from '../util.js';
import { forbiddenRegExp } from '../middleware/validateFileName.js';
import { writeGroupFileAndRow, writeGroupFileAtOtherPath, deleteGroupRow, getGroupFavsByIds, getEntityTagIdsForMany, groupRowExists, getGroupChatStatsByIds } from '../character-metadata-db.js';
import { normalizeFav } from '../../public/scripts/hash-utils.js';
import { isValidGroupId, normalizeGroupId, normalizeGroupRecord } from '../group-id.js';
import { isChatHeaderEntry } from '../chat-header.js';
import { withGroupFilesLock, withGroupLock } from '../group-lock.js';

export const router = express.Router();

/**
 * The id a request names a group by, or null when it can't name one. A group that already exists keeps working
 * whatever its id, so any non-empty string is accepted here, as long as it can't escape the groups directory.
 * Only creating a group requires a valid new-group id (isValidGroupId()).
 * @param {unknown} value
 * @returns {string | null}
 */
function toRequestGroupId(value) {
    const id = normalizeGroupId(value);
    if (id !== null) return id;
    if (typeof value === 'string' && value !== '' && !forbiddenRegExp.test(value)) return value;
    return null;
}

/**
 * Rejects a request whose `body.id` can't name a group with 400, and replaces a legacy numeric id with its string form.
 * @type {import('express').RequestHandler}
 */
function validateGroupIdBody(request, response, next) {
    const id = toRequestGroupId(request.body?.id);
    if (id === null) {
        return response.sendStatus(400);
    }
    request.body.id = id;
    next();
}

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
 * Whether a metadata object holds anything worth keeping.
 * @param {unknown} metadata
 * @returns {boolean}
 */
function hasMetadataContent(metadata) {
    return typeof metadata === 'object' && metadata !== null && Object.keys(metadata).length > 0;
}

/**
 * Copies a file into the backup directory without ever overwriting an earlier, different backup of it:
 * an identical backup is left alone, a different one gets a timestamped sibling instead.
 * @param {string} sourcePath
 * @param {string} backupDir
 * @param {boolean} [onlyIfMissing] Copy only when no backup under the plain name exists yet
 */
async function backUpFile(sourcePath, backupDir, onlyIfMissing = false) {
    const name = path.basename(sourcePath);
    let target = path.join(backupDir, name);
    if (fs.existsSync(target)) {
        if (onlyIfMissing) return;
        const [current, existing] = await Promise.all([fsPromises.readFile(sourcePath), fsPromises.readFile(target)]);
        if (current.equals(existing)) return;
        const ext = path.extname(name);
        target = path.join(backupDir, `${path.basename(name, ext)}.${Date.now()}${ext}`);
    }
    await fsPromises.mkdir(backupDir, { recursive: true });
    await fsPromises.copyFile(sourcePath, target);
}

/**
 * Migrates group metadata to include chat metadata for each group chat instead of the group itself.
 *
 * Metadata is removed from the group JSON only once it has landed in its chat file's header (or the
 * chat file already carries the same metadata). Metadata for a chat file that is missing, unreadable,
 * already headed with different metadata, or not in the group's chat list stays in the group JSON and
 * is listed in a warning. Nothing is written when nothing changes. Each user's groups directory is
 * streamed, one group at a time under that group's lock.
 * @param {import('../users.js').UserDirectoryList[]} userDirectories Listing of all users' directories
 */
export async function migrateGroupChatsMetadataFormat(userDirectories) {
    for (const userDirs of userDirectories) {
        try {
            let anyDataMigrated = false;
            const dir = await fsPromises.opendir(userDirs.groups);
            for await (const groupFile of dir) {
                if (!groupFile.isFile() || path.extname(groupFile.name) !== '.json') {
                    continue;
                }
                if (await withGroupFilesLock(userDirs, [groupFile.name], () => migrateGroupFileMetadataFormat(userDirs, groupFile.name))) {
                    anyDataMigrated = true;
                }
            }
            logGroupMetadataMigrationDone(userDirs, anyDataMigrated);
        } catch (directoryError) {
            console.error(color.red(`Error migrating group chats metadata for user at ${userDirs.root}`), directoryError);
        }
    }
}

/**
 * @param {import('../users.js').UserDirectoryList} userDirs
 * @param {boolean} anyDataMigrated
 */
export function logGroupMetadataMigrationDone(userDirs, anyDataMigrated) {
    if (anyDataMigrated) {
        console.log(color.green(`Completed migration of group chats metadata for user at ${userDirs.root}`));
        console.log(color.cyan(`Backups of modified files are located at ${path.join(userDirs.backups, '_group_metadata_update')}`));
    }
}

/**
 * migrateGroupChatsMetadataFormat() for one group file. The caller holds that group's lock (group-lock.js).
 * @param {import('../users.js').UserDirectoryList} userDirs
 * @param {string} fileName The group's JSON file name within `userDirs.groups`
 * @returns {Promise<boolean>} Whether anything was written
 */
export async function migrateGroupFileMetadataFormat(userDirs, fileName) {
    const backupPath = path.join(userDirs.backups, '_group_metadata_update');
    let wrote = false;
    try {
        const groupFilePath = path.join(userDirs.groups, fileName);
        const groupDataRaw = await fsPromises.readFile(groupFilePath, 'utf8');
        const groupData = tryParse(groupDataRaw) || {};
        const hasChatMetadata = Object.hasOwn(groupData, 'chat_metadata');
        const hasPastMetadata = Object.hasOwn(groupData, 'past_metadata');
        if (!hasChatMetadata && !hasPastMetadata) {
            return false;
        }
        // The first sight of a group still holding legacy metadata is always backed up, so the
        // original survives even if a later group save strips the keys (warnOnGroupMetadata).
        await backUpFile(groupFilePath, backupPath, true);

        /** @type {Record<string, object>} */
        const pastMetadata = typeof groupData.past_metadata === 'object' && groupData.past_metadata !== null ? groupData.past_metadata : {};
        /** @type {Record<string, unknown>} */
        const allMetadata = { ...pastMetadata };
        if (hasChatMetadata) {
            allMetadata[groupData.chat_id] = groupData.chat_metadata;
        }
        if (!Array.isArray(groupData.chats)) {
            console.warn(color.yellow(`Group ${fileName} has no chats array, skipping migration. Its chat metadata stays in the group file.`));
            return wrote;
        }

        /** @type {Map<string, string>} chat id -> why its metadata could not be moved into the chat file */
        const unlanded = new Map();
        /** @type {{ chatId: string, chatFilePath: string, newRaw: string }[]} */
        const chatWrites = [];
        const chatIds = new Set(groupData.chats.map(String));
        for (const chatId of chatIds) {
            const chatMetadata = allMetadata[chatId];
            const chatFileName = sanitize(`${chatId}.jsonl`);
            const chatFilePath = path.join(userDirs.groupChats, chatFileName);
            let chatDataRaw;
            try {
                const stat = await fsPromises.stat(chatFilePath);
                if (!stat.isFile()) throw new Error('not a file');
                chatDataRaw = await fsPromises.readFile(chatFilePath, 'utf8');
            } catch (readError) {
                if (hasMetadataContent(chatMetadata)) {
                    unlanded.set(chatId, `chat file ${chatFileName} not readable (${readError.code ?? readError.message})`);
                }
                continue;
            }
            const firstLine = chatDataRaw.split('\n').find(line => line.trim());
            const firstEntry = firstLine === undefined ? undefined : tryParse(firstLine);
            if (firstLine !== undefined && firstEntry === undefined) {
                if (hasMetadataContent(chatMetadata)) {
                    unlanded.set(chatId, `the first line of ${chatFileName} is not valid JSON`);
                }
                continue;
            }
            if (isChatHeaderEntry(firstEntry)) {
                if (hasMetadataContent(chatMetadata) && JSON.stringify(firstEntry.chat_metadata ?? {}) !== JSON.stringify(chatMetadata)) {
                    unlanded.set(chatId, `${chatFileName} already has a header with different metadata`);
                } else {
                    console.log(color.yellow(`Group chat ${chatId} already has chat metadata, skipping update.`));
                }
                continue;
            }
            // The header goes in front of the file's own bytes, so no line of it can be lost.
            const chatHeader = { chat_metadata: chatMetadata ?? {}, user_name: 'unused', character_name: 'unused' };
            chatWrites.push({ chatId, chatFilePath, newRaw: `${JSON.stringify(chatHeader)}\n${chatDataRaw}` });
        }
        for (const [chatId, chatMetadata] of Object.entries(allMetadata)) {
            if (!chatIds.has(chatId) && hasMetadataContent(chatMetadata)) {
                unlanded.set(chatId, 'the chat is not in the group\'s chat list');
            }
        }

        if (chatWrites.length > 0) {
            await backUpFile(groupFilePath, backupPath);
        }
        for (const { chatId, chatFilePath, newRaw } of chatWrites) {
            try {
                await backUpFile(chatFilePath, backupPath);
                await writeFileAtomic(chatFilePath, newRaw, 'utf8');
                console.log(`Updated group chat data format for ${chatId}`);
                wrote = true;
            } catch (chatError) {
                console.error(color.red(`Could not update existing chat data for ${chatId}`), chatError);
                if (hasMetadataContent(allMetadata[chatId])) {
                    unlanded.set(chatId, `writing its chat file failed (${chatError.message})`);
                }
            }
        }

        const keepChatMetadata = hasChatMetadata && unlanded.has(String(groupData.chat_id));
        const keptPastMetadata = Object.fromEntries(Object.entries(pastMetadata).filter(([chatId]) => unlanded.has(chatId)));
        const keepPastMetadata = Object.keys(keptPastMetadata).length > 0;
        const groupChanged = hasChatMetadata !== keepChatMetadata
            || hasPastMetadata !== keepPastMetadata
            || (keepPastMetadata && Object.keys(keptPastMetadata).length !== Object.keys(pastMetadata).length);

        if (unlanded.size > 0) {
            const listing = [...unlanded].map(([chatId, reason]) => `  - ${chatId}: ${reason}`).join('\n');
            console.warn(color.yellow(`Group ${groupData.id}: chat metadata for these chats could not be moved into their chat files and stays in ${groupFilePath}:\n${listing}`));
        }
        if (!groupChanged) {
            return wrote;
        }
        await backUpFile(groupFilePath, backupPath);
        if (!keepChatMetadata) delete groupData.chat_metadata;
        if (keepPastMetadata) {
            groupData.past_metadata = keptPastMetadata;
        } else {
            delete groupData.past_metadata;
        }
        // A group with no row yet gets it from bootstrapGroupsIfNeeded(), which sets its real date_added and chat stats
        // and may still be running in the background, so no row is inserted here.
        await writeGroupFile(userDirs, groupData, { filePath: groupFilePath, createRow: false });
        console.log(`Migrated group chats metadata for group: ${groupData.id}`);
        wrote = true;
    } catch (groupError) {
        console.error(color.red(`Could not process group file ${fileName}`), groupError);
    }
    return wrote;
}

/**
 * Reads all of a user's groups from disk, with date_added from the file and date_last_chat/chat_size from the group
 * rows, which every message write keeps current (applyGroupChatStats()). A group with no row reports 0 for both.
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<object[]>}
 */
export async function getGroupsData(directories) {
    if (!fs.existsSync(directories.groups)) {
        fs.mkdirSync(directories.groups);
    }

    const files = fs.readdirSync(directories.groups).filter(x => path.extname(x) === '.json');

    return (await readGroupsDataFiles(directories, files)).map(({ group }) => group);
}

/**
 * The groups getGroupsData() returns, in batches of at most `batchSize` `.json` files, without holding the file list
 * or the groups whole.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {number} batchSize
 * @returns {AsyncGenerator<{ fileName: string, group: any }[], void, undefined>}
 */
export async function* streamGroupsDataBatches(directories, batchSize) {
    if (!fs.existsSync(directories.groups)) {
        fs.mkdirSync(directories.groups);
    }

    /** @type {string[]} */
    let files = [];
    for await (const dirent of await fsPromises.opendir(directories.groups)) {
        if (path.extname(dirent.name) !== '.json') continue;
        files.push(dirent.name);
        if (files.length >= batchSize) {
            yield await readGroupsDataFiles(directories, files);
            files = [];
        }
    }
    if (files.length > 0) {
        yield await readGroupsDataFiles(directories, files);
    }
}

/**
 * The groups getGroupsData() returns for just these `.json` files, named within the groups folder. A file that can't
 * be read or parsed is logged and left out.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} files
 * @returns {Promise<{ fileName: string, group: any }[]>} In the order of `files`.
 */
export async function readGroupsDataFiles(directories, files) {
    /** @type {{ fileName: string, group: any }[]} */
    const entries = [];

    for (const file of files) {
        try {
            const filePath = path.join(directories.groups, file);
            const fileContents = fs.readFileSync(filePath, 'utf8');
            const group = normalizeGroupRecord(JSON.parse(fileContents));
            const groupStat = fs.statSync(filePath);
            group.date_added = groupStat.birthtimeMs;
            group.create_date = new Date(groupStat.birthtimeMs).toISOString();
            entries.push({ fileName: file, group });
        } catch (error) {
            console.error(error);
        }
    }

    const statsById = await getGroupChatStatsByIds(directories, entries.map(({ group }) => group.id).filter(id => typeof id === 'string' && id !== ''));
    for (const { group } of entries) {
        const stats = statsById.get(group.id);
        group.date_last_chat = stats?.dateLastChat ?? 0;
        group.chat_size = stats?.chatSize ?? 0;
    }

    return entries;
}

/**
 * Reads just the given group ids' JSON files off disk, without a full directory listing.
 * Does not attach date_added/date_last_chat/chat_size/fav - the caller stamps those from the metadata db
 * so they agree with whatever the page was sorted by.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Record<string, object>} Keyed by group id; missing/unparseable files are simply absent.
 */
export function getGroupsByIds(directories, ids) {
    /** @type {Record<string, object>} */
    const result = {};
    for (const id of ids) {
        try {
            const filePath = path.join(directories.groups, sanitize(`${id}.json`));
            if (!fs.existsSync(filePath)) continue;
            const fileContents = fs.readFileSync(filePath, 'utf8');
            result[id] = normalizeGroupRecord(JSON.parse(fileContents));
        } catch (error) {
            console.error(error);
        }
    }
    return result;
}

/**
 * Overwrites each group's `.tag_ids` with the metadata store's own value, in place - group-side counterpart
 * to characters.js's stampDbTagIds(), same reasoning: the group's JSON file carries no tag assignments,
 * group_tags is the source of truth.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object[]} groups Already-loaded group objects (each with `.id` set) - mutated in place.
 * @returns {Promise<void>}
 */
export async function stampDbTagIds(directories, groups) {
    const ids = groups.map(g => g.id).filter(Boolean);
    if (ids.length === 0) return;
    const tagIdsById = await getEntityTagIdsForMany(directories, ids, { type: 'group' });
    for (const group of groups) {
        group.tag_ids = tagIdsById?.[group.id] ?? [];
    }
}

router.post('/all', async (request, response) => {
    const groups = await getGroupsData(request.user.directories);
    for (const group of groups) {
        group.fav = normalizeFav(group.fav);
    }
    await stampDbTagIds(request.user.directories, groups);
    return response.send(groups);
});

const BATCH_MAX_IDS = 500;

// Group-side counterpart to /api/characters/batch. `fields` omitted returns every field, since groups
// have no shallow/full split - their content hash covers the whole object, so the cache must too.
// More than BATCH_MAX_IDS distinct ids is a 400 rather than a truncated answer, which would read as those groups
// not existing.
router.post('/batch', async (request, response) => {
    try {
        // An id that can't name a group is skipped like an unknown one, so it never fails the rest of the batch.
        const ids = [...new Set((Array.isArray(request.body?.ids) ? request.body.ids : []).map(toRequestGroupId).filter(id => id !== null))];
        if (ids.length > BATCH_MAX_IDS) {
            return response.status(400).send({ error: `at most ${BATCH_MAX_IDS} distinct ids per request` });
        }
        const fields = Array.isArray(request.body?.fields) ? request.body.fields : null;
        if (ids.length === 0) {
            return response.send([]);
        }

        const groupsById = getGroupsByIds(request.user.directories, ids);
        const [favById, tagIdsById] = await Promise.all([
            getGroupFavsByIds(request.user.directories, ids),
            getEntityTagIdsForMany(request.user.directories, ids, { type: 'group' }),
        ]);

        const data = ids
            .filter(id => groupsById[id])
            .map(id => {
                const full = { ...groupsById[id], id, fav: !!favById[id], tag_ids: tagIdsById?.[id] ?? [] };
                if (!fields) return full;
                /** @type {Record<string, any>} */
                const filtered = { id };
                for (const field of fields) {
                    if (field in full) {
                        filtered[field] = full[field];
                    }
                }
                return filtered;
            });
        return response.send(data);
    } catch (err) {
        console.error(err);
        response.status(500).send({ error: true });
    }
});

/**
 * The 500 every route answers when writeGroupFile() throws. writeGroupFile() only throws before the group file
 * changed, so the save did not happen.
 * @param {import('express').Response} response
 * @param {string} id
 * @param {unknown} error
 */
function sendGroupSaveFailed(response, id, error) {
    console.error(`Could not save group ${id}:`, error);
    return response.status(500).send({ error: 'The group could not be saved, so the change was not applied. See the server console for details.' });
}

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
        fav: normalizeFav(request.body.fav),
        chat_id: request.body.chat_id ?? id,
        chats: request.body.chats ?? [id],
        auto_mode_delay: request.body.auto_mode_delay ?? 5,
        generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
        generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
    };
    try {
        if (!fs.existsSync(request.user.directories.groups)) {
            fs.mkdirSync(request.user.directories.groups);
        }
        await withGroupLock(request.user.directories, id, () => writeGroupFile(request.user.directories, groupMetadata));
    } catch (error) {
        return sendGroupSaveFailed(response, id, error);
    }

    return response.send(groupMetadata);
});

router.post('/edit', validateGroupIdBody, async (request, response) => {
    const { directories } = request.user;
    const id = request.body.id;
    if (!isValidGroupId(id) && !fs.existsSync(path.join(directories.groups, sanitize(`${id}.json`))) && !(await groupRowExists(directories, id))) {
        return response.sendStatus(400);
    }
    warnOnGroupMetadata(request.body);
    try {
        await withGroupLock(directories, id, () => writeGroupFile(directories, request.body));
    } catch (error) {
        return sendGroupSaveFailed(response, request.body.id, error);
    }

    return response.send({ ok: true });
});

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {object|null}
 */
/**
 * Reads a group's full descriptor from disk (not the shallow `{id, chats}` view `resolveGroupOwner()`
 * returns) - needed by anything that writes the descriptor back, since a shallow object would clobber
 * every other field on save.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} id
 * @returns {object?}
 */
export function readGroupFile(directories, id) {
    const pathToFile = path.join(directories.groups, sanitize(`${id}.json`));
    if (!fs.existsSync(pathToFile)) {
        return null;
    }
    return normalizeGroupRecord(JSON.parse(fs.readFileSync(pathToFile, 'utf8')));
}

/**
 * Every group file write goes through here, so the group's row (name, fav, digests) is updated from exactly
 * what was written and the digests clients compare against can't go stale (see writeGroupFileAndRow()).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} group
 * @param {object} [options]
 * @param {string} [options.filePath] For callers that found the file by listing the directory. The row is only
 * updated when this is the group's own `<id>.json`, the file every reader of the row opens.
 * @param {boolean} [options.createRow] false: don't insert a missing row (writeGroupFileAndRow()'s createIfMissing).
 */
export async function writeGroupFile(directories, group, { filePath, createRow = true } = {}) {
    normalizeGroupRecord(group);
    group.fav = normalizeFav(group.fav);
    const ownPath = path.join(directories.groups, sanitize(`${group.id}.json`));
    const pathToFile = filePath ?? ownPath;
    const writeFile = () => writeFileAtomicSync(pathToFile, JSON.stringify(group, null, 4));
    if (path.resolve(pathToFile) !== path.resolve(ownPath)) {
        await writeGroupFileAtOtherPath(directories, group, pathToFile, writeFile);
        return;
    }
    await writeGroupFileAndRow(directories, group, writeFile, { createIfMissing: createRow });
}

// Top-level Group fields (see public/global.d.ts's `Group` interface) that /save-partial is allowed to
// merge into the stored group. `id` is deliberately excluded (a group's id is its filename - merging a
// caller-supplied `id` would silently retarget/duplicate the write). This is an allowlist rather than a
// denylist so an unrecognized/stray key (a client bug, or something like `__proto__`/`constructor`
// riding along in a JSON body - Object.assign happily "merges" those into a live object's prototype
// chain) is dropped instead of silently applied.
const GROUP_PARTIAL_ALLOWED_FIELDS = new Set([
    'name', 'members', 'disabled_members', 'chat_id', 'chats',
    'generation_mode', 'generation_mode_join_prefix', 'generation_mode_join_suffix',
    'activation_strategy', 'auto_mode_delay', 'allow_self_responses',
    'avatar_url', 'hideMutedSprites', 'fav', 'date_last_chat',
]);

// Field-level counterpart to /edit for single-property changes (e.g. toggling one member) - avoids
// a whole-object last-write-wins save clobbering unrelated concurrent edits.
router.post('/save-partial', validateGroupIdBody, async (request, response) => {
    const { id, props } = request.body;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        return response.sendStatus(400);
    }

    warnOnGroupMetadata(props);
    /** @type {Record<string, any>} */
    const safeProps = {};
    for (const [key, value] of Object.entries(props)) {
        if (GROUP_PARTIAL_ALLOWED_FIELDS.has(key)) {
            safeProps[key] = value;
        }
    }

    return withGroupLock(request.user.directories, id, async () => {
        const group = readGroupFile(request.user.directories, id);
        if (!group) {
            return response.sendStatus(404);
        }
        Object.assign(group, safeProps);

        try {
            await writeGroupFile(request.user.directories, group);
        } catch (error) {
            return sendGroupSaveFailed(response, id, error);
        }
        return response.send({ ok: true });
    });
});

// Mints a new chat id for an existing group, the same way /create mints one for a brand new group.
router.post('/new-chat', validateGroupIdBody, async (request, response) => {
    const { id } = request.body;
    return withGroupLock(request.user.directories, id, async () => {
        const group = readGroupFile(request.user.directories, id);
        if (!group) {
            return response.sendStatus(404);
        }

        const chatId = String(Date.now());
        group.chats = Array.isArray(group.chats) ? [...group.chats, chatId] : [chatId];
        group.chat_id = chatId;

        try {
            await writeGroupFile(request.user.directories, group);
        } catch (error) {
            return sendGroupSaveFailed(response, id, error);
        }
        return response.send({ chat_id: chatId, chats: group.chats });
    });
});

router.post('/delete', validateGroupIdBody, async (request, response) => {
    const id = request.body.id;
    const pathToGroup = path.join(request.user.directories.groups, sanitize(`${id}.json`));

    await withGroupLock(request.user.directories, id, async () => {
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

        let fileDeleted = false;
        if (fs.existsSync(pathToGroup)) {
            fs.unlinkSync(pathToGroup);
            fileDeleted = true;
        }

        await deleteGroupRow(request.user.directories, id, { fileDeleted }).catch(err =>
            console.error(`Could not remove group metadata store row for ${id}:`, err));
    });

    return response.send({ ok: true });
});
