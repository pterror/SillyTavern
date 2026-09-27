import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color } from './util.js';
import { parseChatFile } from './chat-header.js';
import { getUserDirectoriesList } from './users.js';
import { migrateGroupFileMetadataFormat, logGroupMetadataMigrationDone } from './endpoints/groups.js';
import { groupLockName, withGroupFilesLock } from './group-lock.js';
import { normalizeGroupRecord } from './group-id.js';
import {
    getDbHandle, insertMessageSync, createBranchSync, hasBranchesSync, newId,
    ensureAnchorSync, setDefaultChildSync, alternativesFromMessage, nodeIdentityKey,
} from './message-tree-db.js';

/**
 * Migrates a character's JSONL chat files into the message tree, lazily on first access.
 *
 * Each message's `swipes` expand into sibling rows; `swipe_id` picks which one the file's
 * continuation hangs off and becomes the parent's `default_child_id`. Where `mes` disagrees with
 * `swipes[swipe_id]`, the swipe wins. Dedup key is (parent id, speaker, text) via
 * nodeIdentityKey(), so files sharing a prefix converge onto the same rows. Groups can't be
 * identified by scanning their shared `groupChats/` dir, so callers pass an explicit `fileNames`
 * list instead. Idempotent: an owner with any labeled node is skipped, and the whole migration
 * runs in one transaction.
 */

/**
 * Runs unconditionally before any chat route touches the tree; callers must not branch on the
 * result. Failures are not swallowed — a partial migration rolls back its transaction, and letting
 * the caller proceed anyway would strand un-migrated chats behind an idempotency gate that now
 * thinks the owner is done.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} params.ownerId Character avatar (without .png), or a group's own persistent id
 * @param {string} params.chatDir Directory holding this owner's chat files
 * @param {boolean} [params.isGroup]
 * @param {string[]|null} [params.fileNames] Required for groups, whose files cannot be identified
 * by scanning `chatDir`
 */
export async function migrateOwnerOnTouch(directories, { ownerId, chatDir, isGroup = false, fileNames = null }) {
    await migrateCharacterChats(directories, ownerId, chatDir, isGroup, fileNames);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId Character avatar (without .png) or group ID
 * @param {string} chatDir Absolute path to the directory holding this owner's chat files
 * @param {boolean} isGroup
 * @param {string[]|null} [fileNames] Explicit file names within `chatDir` to migrate, for owners
 * (groups) whose files can't be identified by scanning. Entries naming a missing file are dropped.
 * `null` means scan `chatDir` instead.
 * @returns {Promise<{ migrated: number, skipped: number, errors: string[] }>}
 */
export async function migrateCharacterChats(directories, ownerId, chatDir, isGroup = false, fileNames = null) {
    const db = await getDbHandle(directories);
    if (!db) return { migrated: 0, skipped: 0, errors: ['No SQLite backend available'] };

    if (hasBranchesSync(db, ownerId)) {
        return { migrated: 0, skipped: 0, errors: [] };
    }
    if (!fs.existsSync(chatDir)) {
        return { migrated: 0, skipped: 0, errors: [] };
    }

    // fileNames comes from user-editable group JSON, so it's filtered to look like a real scan
    // result (bare .jsonl name, no path segments, file exists) rather than trusted outright.
    const allFiles = [...new Set(Array.isArray(fileNames)
        ? fileNames.filter(f => typeof f === 'string'
            && f.endsWith('.jsonl')
            && !f.includes('/') && !f.includes('\\') && path.basename(f) === f
            && fs.existsSync(path.join(chatDir, f)))
        : fs.readdirSync(chatDir).filter(f => f.endsWith('.jsonl')),
    )].sort();
    if (allFiles.length === 0) {
        return { migrated: 0, skipped: 0, errors: [] };
    }

    /** @type {string[]} */
    let errors = [];
    /** @type {string[]} */
    let migratedFileNames = [];
    let alreadyMigrated = false;

    db.transaction(() => {
        // A busy retry re-runs this callback after a rollback, so nothing from a previous attempt may
        // survive into the next one - above all `index`, whose ids would name rolled-back rows.
        errors = [];
        migratedFileNames = [];
        // Rechecked inside the transaction: another connection may have migrated this owner since the check above.
        alreadyMigrated = hasBranchesSync(db, ownerId);
        if (alreadyMigrated) return;
        const usedLabels = new Set();
        /** @type {Map<string, string>} */
        const index = new Map();

        const now = Date.now();
        const anchor = ensureAnchorSync(db, ownerId, now);

        for (const fileName of allFiles) {
            const filePath = path.join(chatDir, fileName);
            let raw;
            try {
                raw = fs.readFileSync(filePath, 'utf8');
            } catch (err) {
                errors.push(`Failed to read ${fileName}: ${err.message}; file left in place, not migrated`);
                continue;
            }

            const parsed = parseChatFile(raw);
            if ('error' in parsed) {
                errors.push(`${fileName}: ${parsed.error}; file left in place, not migrated`);
                continue;
            }
            const { header, messages } = parsed;

            const chatName = fileName.replace(/\.jsonl$/, '');
            const cleanMetadata = { ...(header?.chat_metadata || {}) };
            // the tree derives this relationship from content directly
            delete cleanMetadata.main_chat;
            delete cleanMetadata.fork_point;
            if (isGroup) cleanMetadata.__is_group = true;

            // Each file lands whole or not at all: a failure rolls back just this file's rows, and its
            // new dedup keys only join `index` once the file has committed to the outer transaction.
            db.exec('SAVEPOINT migrate_chat_file');
            /** @type {Map<string, string>} */
            const fileIndex = new Map();
            try {
                let parentId = anchor.id;
                let lastId = null;

                for (const msg of messages) {
                    const { contents, selected } = alternativesFromMessage(msg);
                    let chosenId = null;

                    for (let k = 0; k < contents.length; k++) {
                        const content = contents[k];
                        const key = nodeIdentityKey(parentId, content);
                        let id = index.get(key) ?? fileIndex.get(key);
                        if (!id) {
                            id = newId();
                            insertMessageSync(db, {
                                id,
                                parentId,
                                ownerId,
                                content,
                                label: null,
                                // +k preserves swipe order under the (created_at, id) sort used elsewhere
                                createdAt: now + k,
                            });
                            fileIndex.set(key, id);
                        }
                        if (k === selected) chosenId = id;
                    }

                    // set unconditionally so re-walking a shared prefix converges rather than flapping
                    setDefaultChildSync(db, parentId, chosenId);
                    parentId = chosenId;
                    lastId = chosenId;
                }

                // parseChatFile() only returns files with at least one message, so lastId is set here.
                const existing = db.get('SELECT label FROM messages WHERE id = @id', { id: lastId });
                if (existing?.label) {
                    throw new Error(`its last message is already the end of chat "${existing.label}", so chat "${chatName}" and its metadata would have no place in the tree`);
                }
                if (usedLabels.has(chatName)) {
                    throw new Error(`chat name "${chatName}" is already used by an earlier file`);
                }
                createBranchSync(db, {
                    leafId: lastId,
                    name: chatName,
                    isGroup,
                    metadata: JSON.stringify(cleanMetadata),
                });
                db.exec('RELEASE migrate_chat_file');
            } catch (err) {
                db.exec('ROLLBACK TO migrate_chat_file');
                db.exec('RELEASE migrate_chat_file');
                errors.push(`Failed to migrate ${fileName}: ${err.message}; file left in place, not migrated`);
                continue;
            }

            for (const [key, id] of fileIndex) index.set(key, id);
            usedLabels.add(chatName);
            migratedFileNames.push(fileName);
        }
    });
    if (alreadyMigrated) {
        return { migrated: 0, skipped: 0, errors: [] };
    }

    // Only files whose every message, name and metadata landed in the committed transaction get here.
    for (const fileName of migratedFileNames) {
        try {
            const filePath = path.join(chatDir, fileName);
            const preMigPath = filePath + '.pre-migration';
            if (!fs.existsSync(preMigPath)) fs.renameSync(filePath, preMigPath);
        } catch (err) {
            errors.push(`Failed to rename ${fileName}: ${err.message}`);
        }
    }

    const migrated = migratedFileNames.length;
    const skipped = allFiles.length - migrated;
    console.log(color.green(`[message-tree] Migrated ${migrated} chats for ${ownerId} (${skipped} skipped, ${errors.length} errors)`));
    for (const error of errors) {
        console.warn(color.yellow(`[message-tree] ${ownerId}: ${error}`));
    }

    return { migrated, skipped, errors };
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} fileName
 * @returns {string | null} The id in that group file, or null when it has none or can't be read
 */
function readGroupFileId(directories, fileName) {
    try {
        const id = normalizeGroupRecord(JSON.parse(fs.readFileSync(path.join(directories.groups, fileName), 'utf8')))?.id;
        return typeof id === 'string' && id !== '' ? id : null;
    } catch {
        return null;
    }
}

/**
 * Migrates one group: its metadata-format migration, then its tree migration, both under the group's lock. The
 * metadata migration goes first because it can only give an old-format (headerless) chat file its header and
 * metadata while that file is still at `<chatId>.jsonl`, and the tree migration renames every file it migrates.
 *
 * Both the group's file name and the id inside it are locked: routes lock a group by its id, which names a
 * different file when the file isn't named after its id.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} fileName The group's JSON file name within `directories.groups`
 * @returns {Promise<boolean>} Whether the metadata migration wrote anything
 */
export async function migrateGroupFile(directories, fileName) {
    const filePath = path.join(directories.groups, fileName);
    for (;;) {
        const lockedId = readGroupFileId(directories, fileName);
        const lockNames = lockedId === null ? [fileName] : [fileName, groupLockName(lockedId)];
        const outcome = await withGroupFilesLock(directories, lockNames, async () => {
            if (!fs.existsSync(filePath)) return { wrote: false };
            if (readGroupFileId(directories, fileName) !== lockedId) return null;

            const wrote = await migrateGroupFileMetadataFormat(directories, fileName);

            let group;
            try {
                group = normalizeGroupRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            } catch (err) {
                console.error(color.red(`[message-tree] Failed to read group file ${fileName} for ${directories.root}, its chats were not migrated:`), err);
                return { wrote };
            }
            if (typeof group?.id === 'string' && Array.isArray(group.chats)) {
                await migrateOwnerOnTouch(directories, {
                    ownerId: group.id,
                    chatDir: directories.groupChats,
                    isGroup: true,
                    fileNames: group.chats.map(c => `${c}.jsonl`),
                });
            }
            return { wrote };
        });
        // null: the file's id changed before the lock was held, so the id's lock was the wrong one.
        if (outcome !== null) return outcome.wrote;
    }
}

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

/**
 * One user's part of migrateAllGroupChats(): streams the user's groups directory and migrates one group at a time
 * (migrateGroupFile()), yielding to the event loop between groups so requests are served while it runs.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {() => Promise<void>} [options.yieldBetweenGroups]
 */
export async function migrateUserGroupChats(directories, { yieldBetweenGroups = yieldToEventLoop } = {}) {
    let dir;
    try {
        dir = await fsPromises.opendir(directories.groups);
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return;
        console.error(color.red(`[message-tree] Failed to read groups for ${directories.root}:`), err);
        return;
    }

    let anyMetadataMigrated = false;
    for await (const entry of dir) {
        if (!entry.isFile() || path.extname(entry.name) !== '.json') continue;
        try {
            if (await migrateGroupFile(directories, entry.name)) anyMetadataMigrated = true;
        } catch (err) {
            console.error(color.red(`[message-tree] Failed to migrate group file ${entry.name} for ${directories.root}; it is retried on its next open and next boot:`), err);
        }
        await yieldBetweenGroups();
    }
    logGroupMetadataMigrationDone(directories, anyMetadataMigrated);
}

/**
 * Migrates every group's chats (metadata format, then tree) for every user, one user and one group at a time.
 * Next-touch migration (migrateOwnerOnTouch via touchGroupOwner) only fires when something actually opens a group,
 * so a group nobody has opened since the tree DB shipped would otherwise stay JSONL-backed indefinitely.
 */
export async function migrateAllGroupChats() {
    const directoriesList = await getUserDirectoriesList();

    for (const directories of directoriesList) {
        await migrateUserGroupChats(directories);
    }
}

/**
 * Runs migrateAllGroupChats() in the background, for server-main.js to call once the server is listening, then
 * `afterMigration` once every user's pass has finished, never when the pass failed. Failures are logged; the
 * returned promise never rejects.
 * @param {object} [options]
 * @param {() => (Promise<void> | void)} [options.afterMigration]
 * @param {() => Promise<void>} [options.migrate]
 * @returns {Promise<void>}
 */
export function startGroupChatMigrations({ afterMigration = () => {}, migrate = migrateAllGroupChats } = {}) {
    return migrate()
        .then(
            () => afterMigration(),
            err => console.error(color.red('[message-tree] Group chat migration failed, so what waits on it was not started:'), err),
        )
        .catch(err => console.error(color.red('[message-tree] A task run after the group chat migration failed:'), err));
}

/**
 * Migrates every character's JSONL chats into the tree for every user, synchronously at server
 * startup - the character-side equivalent of migrateAllGroupChats() above, for the exact same
 * reason: next-touch migration (migrateOwnerOnTouch, called from /save, /get, /rename) only fires
 * when something actually opens that character, so a character nobody has opened since the tree DB
 * shipped (including one imported after that point) would otherwise stay JSONL-backed indefinitely.
 */
export async function migrateAllCharacterChats() {
    const directoriesList = await getUserDirectoriesList();

    for (const directories of directoriesList) {
        let entries;
        try {
            entries = fs.readdirSync(directories.chats, { withFileTypes: true });
        } catch (err) {
            console.error(color.red(`[message-tree] Failed to read chats directory for ${directories.root}:`), err);
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            await migrateOwnerOnTouch(directories, {
                ownerId: entry.name,
                chatDir: path.join(directories.chats, entry.name),
            });
        }
    }
}
