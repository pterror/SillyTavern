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
    ensureAnchorSync, setDefaultChildSync, alternativesFromMessage, identityHashOf,
} from './message-tree-db.js';

/**
 * Migrates a character's JSONL chat files into the message tree, lazily on first access.
 *
 * Each message's `swipes` expand into sibling rows; `swipe_id` picks which one the file's
 * continuation hangs off and becomes the parent's `default_child_id`. Where `mes` disagrees with
 * `swipes[swipe_id]`, the swipe wins. Dedup key is (parent id, speaker, text) via
 * nodeIdentityKey(), looked up as the row's identity_hash, so files sharing a prefix converge onto
 * the same rows, including rows already in the tree. Groups can't be identified by scanning their
 * shared `groupChats/` dir, so callers pass an explicit `fileNames` list instead. Idempotent: an
 * owner with any labeled node is skipped (unless `retryUnmigrated`, see migrateCharacterChats()),
 * and the whole migration runs in one transaction.
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
 * @param {boolean} [params.retryUnmigrated] See migrateCharacterChats()
 * @param {import('./message-tree-db.js').OwnerDescriptor} [params.owner] See migrateCharacterChats()
 * @returns {Promise<{ migrated: number, skipped: number, errors: string[] }>} For the boot group pass, which
 * tracks files left un-migrated; route callers ignore it
 */
export async function migrateOwnerOnTouch(directories, { ownerId, chatDir, isGroup = false, fileNames = null, retryUnmigrated = false, owner = undefined }) {
    return await migrateCharacterChats(directories, ownerId, chatDir, isGroup, fileNames, { retryUnmigrated, owner });
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId Character avatar (without .png) or group ID
 * @param {string} chatDir Absolute path to the directory holding this owner's chat files
 * @param {boolean} isGroup
 * @param {string[]|null} [fileNames] Explicit file names within `chatDir` to migrate, for owners
 * (groups) whose files can't be identified by scanning. Entries naming a missing file are dropped.
 * `null` means scan `chatDir` instead.
 * @param {object} [options]
 * @param {boolean} [options.retryUnmigrated] Migrate every listed file still at its `.jsonl` name even when the
 * owner already has chats in the tree, instead of skipping such an owner. The boot group pass sets it, so a file an
 * earlier run refused is retried (and reported again if still refused) every boot until it migrates. Existing rows
 * are reused and never changed, except to set a `default_child_id` that was unset.
 * @param {import('./message-tree-db.js').OwnerDescriptor} [options.owner] The owner's kind, recorded if this migration
 * creates its anchor. A group's is known from `isGroup`.
 * @returns {Promise<{ migrated: number, skipped: number, errors: string[] }>}
 */
export async function migrateCharacterChats(directories, ownerId, chatDir, isGroup = false, fileNames = null, { retryUnmigrated = false, owner = undefined } = {}) {
    const db = await getDbHandle(directories);
    if (!db) return { migrated: 0, skipped: 0, errors: ['No SQLite backend available'] };

    if (!retryUnmigrated && hasBranchesSync(db, ownerId)) {
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
        const ownerHadBranches = hasBranchesSync(db, ownerId);
        alreadyMigrated = ownerHadBranches && !retryUnmigrated;
        if (alreadyMigrated) return;
        const usedLabels = new Set();

        const now = Date.now();
        const anchor = ensureAnchorSync(db, ownerId, now, owner ?? (isGroup ? { kind: 'group', rowId: ownerId } : undefined));

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

            // Each file lands whole or not at all: a failure rolls back just this file's rows.
            db.exec('SAVEPOINT migrate_chat_file');
            try {
                let parentId = anchor.id;
                let lastId = null;

                for (const msg of messages) {
                    const { contents, selected } = alternativesFromMessage(msg);
                    let chosenId = null;

                    for (let k = 0; k < contents.length; k++) {
                        const content = contents[k];
                        let id = /** @type {{ id: string } | undefined} */ (db.get(
                            'SELECT id FROM messages WHERE parent_id = @parentId AND identity_hash = @hash LIMIT 1',
                            { parentId, hash: identityHashOf(parentId, content) }))?.id;
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
                        }
                        if (k === selected) chosenId = id;
                    }

                    // On a new owner the last file's choice wins, so re-walking a shared prefix converges rather than
                    // flapping. An owner that already had chats keeps every default it has; only unset ones are filled.
                    if (!ownerHadBranches || !db.get('SELECT default_child_id AS d FROM messages WHERE id = @id', { id: parentId })?.d) {
                        setDefaultChildSync(db, parentId, chosenId);
                    }
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
                if (db.get('SELECT 1 AS ok FROM messages WHERE owner_id = @ownerId AND label = @chatName LIMIT 1', { ownerId, chatName })) {
                    throw new Error(`chat name "${chatName}" is already a chat in the tree`);
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
            if (fs.existsSync(preMigPath)) {
                errors.push(`${fileName} was migrated but not renamed, since ${fileName}.pre-migration already exists`);
            } else {
                fs.renameSync(filePath, preMigPath);
            }
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
 *
 * The boot pass and the on-open path (touchGroupOwner) both run this, so a group opened before the pass reaches it
 * gets its metadata into its chat files, and from there into the tree, on that open.
 *
 * With `retryUnmigrated` (the boot pass) the tree migration retries every chat file of the group still at
 * `<chatId>.jsonl`, even when the group already has chats in the tree, so a file refused on an earlier boot is tried
 * again and reported again until it migrates. Without it (on open) a group that already has chats is left to the pass.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} fileName The group's JSON file name within `directories.groups`
 * @param {object} [options]
 * @param {boolean} [options.retryUnmigrated] See migrateCharacterChats()
 * @returns {Promise<{ wrote: boolean, unmigrated: boolean, group: { id: string, chats: string[] } | null }>} Whether
 * the metadata migration wrote anything; whether any of the group's chat files may be left un-migrated (refused, not
 * renamed, or the group unreadable); and the group's id and chat list as read under the lock after the metadata
 * migration, `null` when the file is gone, unreadable or has no id
 */
export async function migrateGroupFile(directories, fileName, { retryUnmigrated = true } = {}) {
    const filePath = path.join(directories.groups, fileName);
    for (;;) {
        const lockedId = readGroupFileId(directories, fileName);
        const lockNames = lockedId === null ? [fileName] : [fileName, groupLockName(lockedId)];
        const outcome = await withGroupFilesLock(directories, lockNames, async () => {
            if (!fs.existsSync(filePath)) return { wrote: false, unmigrated: false, group: null };
            if (readGroupFileId(directories, fileName) !== lockedId) return null;

            const wrote = await migrateGroupFileMetadataFormat(directories, fileName);

            let group;
            try {
                group = normalizeGroupRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            } catch (err) {
                console.error(color.red(`[message-tree] Failed to read group file ${fileName} for ${directories.root}, its chats were not migrated:`), err);
                return { wrote, unmigrated: true, group: null };
            }
            if (typeof group?.id !== 'string') return { wrote, unmigrated: false, group: null };
            if (!Array.isArray(group.chats)) return { wrote, unmigrated: false, group: { id: group.id, chats: [] } };
            const { errors } = await migrateOwnerOnTouch(directories, {
                ownerId: group.id,
                chatDir: directories.groupChats,
                isGroup: true,
                fileNames: group.chats.map(c => `${c}.jsonl`),
                retryUnmigrated,
            });
            return { wrote, unmigrated: errors.length > 0, group: { id: group.id, chats: group.chats } };
        });
        // null: the file's id changed before the lock was held, so the id's lock was the wrong one.
        if (outcome !== null) return outcome;
    }
}

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

/**
 * One user's part of migrateAllGroupChats(): streams the user's groups directory and migrates one group at a time
 * (migrateGroupFile()), yielding to the event loop between groups so requests are served while it runs.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {() => Promise<void>} [options.yieldBetweenGroups]
 * @returns {Promise<{ unmigrated: boolean }>} Whether any of the user's group chat files may be left un-migrated
 */
export async function migrateUserGroupChats(directories, { yieldBetweenGroups = yieldToEventLoop } = {}) {
    let dir;
    try {
        dir = await fsPromises.opendir(directories.groups);
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { unmigrated: false };
        console.error(color.red(`[message-tree] Failed to read groups for ${directories.root}:`), err);
        return { unmigrated: true };
    }

    let anyMetadataMigrated = false;
    let unmigrated = false;
    for await (const entry of dir) {
        if (!entry.isFile() || path.extname(entry.name) !== '.json') continue;
        try {
            const outcome = await migrateGroupFile(directories, entry.name);
            if (outcome.wrote) anyMetadataMigrated = true;
            if (outcome.unmigrated) unmigrated = true;
        } catch (err) {
            unmigrated = true;
            console.error(color.red(`[message-tree] Failed to migrate group file ${entry.name} for ${directories.root}; it is retried on its next open and next boot:`), err);
        }
        await yieldBetweenGroups();
    }
    logGroupMetadataMigrationDone(directories, anyMetadataMigrated);
    return { unmigrated };
}

/**
 * @typedef {object} GroupChatMigrationOutcome
 * @property {import('./users.js').UserDirectoryList[]} migrated Users with no group chat file left un-migrated
 * @property {import('./users.js').UserDirectoryList[]} unmigrated Users with a group chat file left un-migrated
 */

/**
 * Migrates every group's chats (metadata format, then tree) for every user, one user and one group at a time.
 * Next-touch migration (migrateOwnerOnTouch via touchGroupOwner) only fires when something actually opens a group,
 * so a group nobody has opened since the tree DB shipped would otherwise stay JSONL-backed indefinitely.
 * @param {import('./users.js').UserDirectoryList[]} [directoriesList] Every user's, when omitted
 * @returns {Promise<GroupChatMigrationOutcome>}
 */
export async function migrateAllGroupChats(directoriesList) {
    directoriesList ??= await getUserDirectoriesList();
    /** @type {GroupChatMigrationOutcome} */
    const outcome = { migrated: [], unmigrated: [] };

    for (const directories of directoriesList) {
        const { unmigrated } = await migrateUserGroupChats(directories);
        outcome[unmigrated ? 'unmigrated' : 'migrated'].push(directories);
    }
    return outcome;
}

/**
 * Runs migrateAllGroupChats() in the background, for server-main.js to call once the server is listening, then
 * `afterMigration` with its outcome once every user's pass has finished, never when the pass failed. Failures are
 * logged; the returned promise never rejects.
 * @param {object} [options]
 * @param {(outcome: GroupChatMigrationOutcome) => (Promise<void> | void)} [options.afterMigration]
 * @param {() => Promise<GroupChatMigrationOutcome>} [options.migrate]
 * @returns {Promise<void>}
 */
export function startGroupChatMigrations({ afterMigration = () => {}, migrate = () => migrateAllGroupChats() } = {}) {
    return migrate()
        .then(
            outcome => afterMigration(outcome),
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
