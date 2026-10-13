import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync, default as writeFileAtomic } from 'write-file-atomic';

import { color, tryParse, writeBackpressured } from '../util.js';
import { forbiddenRegExp } from '../middleware/validateFileName.js';
import { groupDigestContentHash, groupDigestFavHash, groupDigestTagIdsHash, normalizeFav } from '../../public/scripts/hash-utils.js';
import { isValidGroupId, normalizeGroupId, normalizeGroupRecord } from '../group-id.js';
import { isChatHeaderEntry } from '../chat-header.js';
import { withGroupFilesLock } from '../group-lock.js';
import { requestStore, userStore } from '../user-stores.js';
import { TYPE } from '../library-engine.js';
import { requestSession } from '../request-session.js';
import { droppedOf, moveToChatNamed } from '../chat-request.js';
import { bookmarkCompatId, sessionCompatId } from '../chat-engine.js';

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
        writeFileAtomicSync(groupFilePath, JSON.stringify(normalizeGroupRecord(groupData), null, 4));
        console.log(`Migrated group chats metadata for group: ${groupData.id}`);
        wrote = true;
    } catch (groupError) {
        console.error(color.red(`Could not process group file ${fileName}`), groupError);
    }
    return wrote;
}

/**
 * Groups as the library stores them (`/api/groups/batch`'s objects: their own values, id, fav and tag ids), by id;
 * a group no id names is absent.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<Record<string, Record<string, any>>>}
 */
export async function getGroupsByIds(directories, ids) {
    const groups = await (await userStore(directories)).lib.groups(ids);
    /** @type {Record<string, Record<string, any>>} */
    const result = {};
    ids.forEach((id, i) => {
        if (groups[i]) result[id] = /** @type {Record<string, any>} */ (groups[i]);
    });
    return result;
}

/**
 * The compat chat values of a group for a request: `chat_id`, the UUID of the session the request acts through in
 * its tree, and `chats`, the group's chat list (`chatList()`: the tab's session when it is there, then the
 * bookmarks), each by its compat chat id (a session's UUID, a bookmark's id).
 * @param {import('../user-stores.js').UserStore} store
 * @param {import('express').Request} request
 * @param {bigint} tree
 * @param {import('../request-session.js').RequestSession} [acted] The request's session when it has acted (it may
 *   have made one).
 * @returns {Promise<{ chat_id: string, chats: string[] }>}
 */
async function groupChats(store, request, tree, acted) {
    const session = acted ?? await requestSession(store.chats, request, tree);
    const chats = [];
    /** @type {string | undefined} */
    let after;
    for (;;) {
        const page = await store.chats.chatList({ tree, session: session.reader().session ?? undefined, after, limit: 500 });
        chats.push(...page.rows.map(r => (r.bookmark != null ? bookmarkCompatId(r.bookmark) : sessionCompatId(String(r.session), tree))));
        if (!page.more || page.rows.length === 0) break;
        after = page.rows[page.rows.length - 1].position;
    }
    return { chat_id: await store.chats.compatChatId(session.reader().session, session.identifier, tree), chats };
}

/**
 * Groups as upstream's routes answer them, for a request: the stored object (`getGroupsByIds()`) with its compat
 * `chat_id` and `chats`; with `listed`, also its dates and chat stats, as `/all` lists them. null for an id no group
 * has.
 * @param {import('express').Request} request
 * @param {string[]} ids
 * @param {{ listed?: boolean }} [o]
 * @returns {Promise<(Record<string, any> | null)[]>}
 */
export async function groupObjects(request, ids, { listed = false } = {}) {
    const store = await requestStore(request);
    const { lib } = store;
    const entities = await lib.entities(await lib.ids(TYPE.group, ids));
    const groups = await lib.groups(ids);
    const present = /** @type {bigint[]} */ (entities.filter(e => e !== null).map(e => /** @type {any} */ (e).id));
    const stats = listed ? await lib.chatStats(present) : new Map();
    return Promise.all(groups.map(async (g, i) => {
        const e = entities[i];
        if (!g || !e) return null;
        const group = { ...g, ...(await groupChats(store, request, e.id)) };
        if (!listed) return group;
        return {
            ...group,
            date_added: e.added,
            create_date: new Date(e.added).toISOString(),
            date_last_chat: stats.get(e.id)?.date_last_chat ?? 0,
            chat_size: stats.get(e.id)?.chat_size ?? 0,
        };
    }));
}

/**
 * A group's hash row digests, over the object `/batch` answers for it.
 * @param {Record<string, any>} group
 */
export function groupDigests(group) {
    return {
        favHash: groupDigestFavHash(group) >>> 0,
        tagIdsHash: groupDigestTagIdsHash(group) >>> 0,
        contentHash: groupDigestContentHash(group) >>> 0,
    };
}

/** Groups read a page at a time by `/all`. */
const ALL_PAGE = 200;

/** Every group (upstream's `/all`: a bare array, streamed a page at a time), in name order. */
router.post('/all', async (request, response) => {
    try {
        const { lib } = await requestStore(request);
        response.set('Content-Type', 'application/json');
        response.status(200);
        let wroteAny = false;
        try {
            await writeBackpressured(response, '[');
            /** @type {string | undefined} */
            let cursor;
            for (;;) {
                const page = await lib.query({ sortField: 'name', limit: ALL_PAGE, cursor, wantRows: false, wantTotal: false, wantHashes: true, groupsOnly: true });
                const rows = /** @type {{ id: string }[]} */ (page.hashRows);
                for (const group of await groupObjects(request, rows.map(r => r.id), { listed: true })) {
                    if (!group) continue;
                    await writeBackpressured(response, (wroteAny ? ',' : '') + JSON.stringify(group));
                    wroteAny = true;
                }
                if (typeof page.cursor !== 'string' || rows.length === 0) break;
                cursor = page.cursor;
            }
            await writeBackpressured(response, ']');
        } catch (streamErr) {
            console.error('[groups/all] Streaming response failed mid-flight; ending the connection:', streamErr);
        }
        return response.end();
    } catch (err) {
        console.error(err);
        return response.status(500).send({ error: true });
    }
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
        const data = (await groupObjects(request, ids)).filter(g => g !== null).map(full => {
            if (!fields) return full;
            /** @type {Record<string, any>} */
            const filtered = { id: /** @type {any} */ (full).id };
            for (const field of fields) {
                if (field in /** @type {any} */ (full)) filtered[field] = /** @type {any} */ (full)[field];
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
 * The 500 a route answers when a group couldn't be stored; nothing of it was.
 * @param {import('express').Response} response
 * @param {string} id
 * @param {unknown} error
 */
function sendGroupSaveFailed(response, id, error) {
    console.error(`Could not save group ${id}:`, error);
    return response.status(500).send({ error: 'The group could not be saved, so the change was not applied. See the server console for details.' });
}

/**
 * A group as stored: what `writeGroup()` keeps of a group object (its compat chat values, read-time keys, aren't).
 * @param {Record<string, any>} group
 */
function storedGroup(group) {
    normalizeGroupRecord(group);
    const stored = { ...group, fav: normalizeFav(group.fav) };
    delete stored.chat_id;
    delete stored.chats;
    return stored;
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
        auto_mode_delay: request.body.auto_mode_delay ?? 5,
        generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
        generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
    };
    try {
        const { lib } = await requestStore(request);
        await lib.writeGroup(storedGroup(groupMetadata));
        const [group] = await groupObjects(request, [id]);
        return response.send(group);
    } catch (error) {
        return sendGroupSaveFailed(response, id, error);
    }
});

/**
 * Upstream's whole-group save. Its `chat_id` moves the requesting tab's session to the chat it names ('' or null: a
 * new chat); `chats` is the group's chat list, read from its bookmarks, so a write of it does nothing.
 */
router.post('/edit', validateGroupIdBody, async (request, response) => {
    const id = request.body.id;
    const { lib } = await requestStore(request);
    if (!isValidGroupId(id) && (await lib.ids(TYPE.group, [id]))[0] === null) {
        return response.sendStatus(400);
    }
    warnOnGroupMetadata(request.body);
    try {
        await lib.writeGroup(storedGroup({ ...request.body }));
        if (Object.hasOwn(request.body, 'chat_id')) {
            await moveToChatNamed(request, response, { group: id }, request.body.chat_id);
        }
    } catch (error) {
        return sendGroupSaveFailed(response, request.body.id, error);
    }

    return response.send({ ok: true });
});

// Top-level Group fields (see public/global.d.ts's `Group` interface) that /save-partial is allowed to
// merge into the stored group. `id` is deliberately excluded (a group's id is its key - merging a
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

/**
 * Upstream's read-time group keys: not stored with the group (`date_last_chat` is its chat stats'), so a partial
 * save of them changes nothing but `chat_id`, which moves the tab's session as `/edit`'s does.
 */
const GROUP_READ_TIME_FIELDS = new Set(['chat_id', 'chats', 'date_last_chat']);

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
        if (GROUP_PARTIAL_ALLOWED_FIELDS.has(key) && !GROUP_READ_TIME_FIELDS.has(key)) {
            safeProps[key] = value;
        }
    }

    const { lib } = await requestStore(request);
    try {
        const written = await lib.updateGroup(id, group => Object.assign(group, safeProps));
        if (!written) return response.sendStatus(404);
        if (Object.hasOwn(props, 'chat_id')) {
            await moveToChatNamed(request, response, { group: id }, props.chat_id);
        }
    } catch (error) {
        return sendGroupSaveFailed(response, id, error);
    }
    return response.send({ ok: true });
});

/**
 * Changes one member of a group: `op` is `add` (to the front), `remove`, `up`, `down`, `mute`, `unmute` or `replace`
 * (by `new_avatar`, in place), for the member `avatar`. Works on the group as stored, so two tabs changing different members both keep their change.
 * Answers `{ members, disabled_members }` as stored. Writes nothing when nothing changes.
 */
router.post('/members', validateGroupIdBody, async (request, response) => {
    const { id, op, avatar, new_avatar: newAvatar } = request.body;
    if (typeof avatar !== 'string' || !avatar || !['add', 'remove', 'up', 'down', 'mute', 'unmute', 'replace'].includes(op)) {
        return response.status(400).send({ error: 'avatar and op (add, remove, up, down, mute, unmute, replace) are required' });
    }
    if (op === 'replace' && (typeof newAvatar !== 'string' || !newAvatar)) {
        return response.status(400).send({ error: 'replace needs new_avatar' });
    }
    const { lib } = await requestStore(request);
    /** @type {{ members: string[], disabled_members: string[] } | null} */
    let answer = null;
    try {
        const written = await lib.updateGroup(id, group => {
            const members = Array.isArray(group.members) ? [...group.members] : [];
            const disabled = Array.isArray(group.disabled_members) ? [...group.disabled_members] : [];
            const at = members.indexOf(avatar);
            if (op === 'add' && at === -1) members.unshift(avatar);
            if (op === 'remove' && at !== -1) members.splice(at, 1);
            if (op === 'remove' && disabled.includes(avatar)) disabled.splice(disabled.indexOf(avatar), 1);
            const swapWith = op === 'up' ? at - 1 : op === 'down' ? at + 1 : -1;
            if (at !== -1 && swapWith >= 0 && swapWith < members.length) [members[at], members[swapWith]] = [members[swapWith], members[at]];
            if (op === 'mute' && at !== -1 && !disabled.includes(avatar)) disabled.push(avatar);
            if (op === 'unmute' && disabled.includes(avatar)) disabled.splice(disabled.indexOf(avatar), 1);
            if (op === 'replace' && at !== -1) {
                members[at] = newAvatar;
                if (disabled.includes(avatar)) disabled[disabled.indexOf(avatar)] = newAvatar;
            }
            group.members = members;
            group.disabled_members = disabled;
            answer = { members, disabled_members: disabled };
        });
        if (!written || !answer) return response.sendStatus(404);
    } catch (error) {
        return sendGroupSaveFailed(response, id, error);
    }
    return response.send(answer);
});

/**
 * A new chat in a group (answer 4 of the cut): the requesting tab's session goes to the group's root, where the
 * members' greetings show provisionally. Answers the compat `chat_id` and `chats`.
 */
router.post('/new-chat', validateGroupIdBody, async (request, response) => {
    const { id } = request.body;
    try {
        const store = await requestStore(request);
        const [tree] = await store.people.trees([{ group: id }]);
        if (tree === null || tree === undefined) {
            return response.sendStatus(404);
        }
        const session = await requestSession(store.chats, request, tree);
        await store.chats.newChat({ tree, actor: session.actor(), group: true });
        await store.chats.setCurrentChat({ tree, bookmark: null, actor: session.actor() });
        session.answer(response, { moved: true });
        return response.send(await groupChats(store, request, tree, session));
    } catch (error) {
        return sendGroupSaveFailed(response, id, error);
    }
});

/**
 * Deletes a group. Its chats are kept as an unowned tree a group made with its id again takes back (upstream left
 * its chat files on disk); with `delete_chats` they go too.
 */
/**
 * Deletes a group and its chats (its whole tree, in slices), as upstream's delete always removed its chat files;
 * `delete_chats` is not read. The bookmarks and state changes that go are logged and answered in `dropped`.
 */
router.post('/delete', validateGroupIdBody, async (request, response) => {
    const id = request.body.id;
    const store = await requestStore(request);
    const [tree] = await store.lib.ids(TYPE.group, [id]);
    /** @type {any} */
    let drops = null;
    if (tree !== null) {
        const session = await requestSession(store.chats, request, tree);
        const deleted = await store.chats.deleteTree({ tree, actor: session.actor() });
        drops = droppedOf(deleted);
        if (drops) console.warn(`[groups/delete] Deleting group ${id} dropped:`, JSON.stringify(drops));
        await store.lib.deleteEntity(TYPE.group, id);
    }
    return response.send({ ok: true, ...(drops ? { dropped: drops } : {}) });
});
