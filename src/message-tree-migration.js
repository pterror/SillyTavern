import fs from 'node:fs';
import path from 'node:path';

import { color } from './util.js';
import {
    getDbHandle, insertMessageSync, createBranchSync, hasBranchesSync, newId,
    ensureAnchorSync, setDefaultChildSync, alternativesFromMessage, nodeIdentityKey,
} from './message-tree-db.js';

/**
 * Migrates a character's JSONL chat files into the message tree. Called lazily on first access to a
 * character's chats, so only active characters pay the cost.
 *
 * Algorithm:
 * 1. Ensure the owner's synthetic anchor row exists. Every walk starts there, uniformly — a character
 *    with one JSONL file and a character with 1085 divergent openings produce the same shape, so no
 *    code downstream ever has to special-case "the first message".
 * 2. Read the owner's .jsonl files in a deterministic (sorted) order. Which files those ARE is not
 *    always a property of the directory: a character owns everything in `chats/<cardName>/`, so
 *    scanning is exactly right, but every group chat of every group sits flat in the one shared
 *    `groupChats/` directory and the group's own descriptor is the only thing that says which chat
 *    ids belong to it. Scanning there would file every group's history under whichever owner
 *    happened to migrate first, so callers in that position hand in an explicit file list instead
 *    (see the `fileNames` parameter). Everything after this step is identical either way - the two
 *    modes differ only in how the list is obtained, never in what is done with it.
 * 3. Walk each file's messages. Each message expands into its alternatives: a `swipes` array of length
 *    N becomes N sibling rows sharing a parent, with `swipe_info[i]`'s send_date/extra folded onto
 *    alternative i (once the array is gone there is nowhere else for that per-alternative data to
 *    live). The alternative at `swipe_id` is the one the file's own continuation hangs off, and is
 *    what the parent's `default_child_id` points at. Where the stored `mes` disagrees with
 *    `swipes[swipe_id]`, `swipes[swipe_id]` wins — the divergence was drift from the old
 *    mes/swipes sync, not a second source of truth, and with every alternative now its own row the
 *    distinction doesn't exist to preserve.
 * 4. Identity for dedup is (parent row id, speaker, message text) via the shared
 *    nodeIdentityKey(). A node with that
 *    identity already inserted in this run is reused rather than duplicated, so files sharing a
 *    prefix converge onto the same rows regardless of processing order.
 * 5. The file's chat name becomes a `label` on the node its walk ended at, with the file's
 *    chat_metadata parked in that node's `metadata` column. There is no branches table.
 * 6. After a successful migration the .jsonl files are renamed to .jsonl.pre-migration.
 *
 * Idempotent: an owner with any labeled node is skipped entirely, and one owner's whole migration
 * runs inside a single transaction, so a crash leaves nothing half-committed.
 */

/**
 * The precondition every chat route runs before touching the tree: if this owner's chats are still
 * files, move them in, once, now.
 *
 * The shape here is the entire point, so it is worth being exact about what this is NOT. It is not a
 * question the caller asks and then chooses a code path from. `ensureTreeMigrated()` was that, and it
 * was deleted for it: asking "is this migrated?" per request means two live storage paths forever,
 * the file one quietly accruing features and bugs of its own, and every route carrying a branch that
 * is wrong in one of its two arms. Callers of this run it unconditionally, ignore what it returns,
 * and then have exactly one path - the tree. Nothing downstream may branch on the result, and this
 * returns `void` so that nothing can.
 *
 * Cheap enough to sit on a hot path: for an owner that has already been through it, this is one
 * indexed `LIMIT 1` lookup inside migrateCharacterChats() and nothing else - no directory read, no
 * file I/O.
 *
 * Failures are deliberately NOT swallowed. If a migration dies partway, its transaction rolls back
 * and no file is renamed, so the owner is exactly where it started - but only if the request that
 * triggered it stops there too. Letting the caller carry on and write to the tree anyway is the bad
 * outcome: that write labels a node, the owner now looks migrated to the idempotency gate, and the
 * chats still sitting in JSONL are stranded where nothing will ever look for them again. So this
 * throws, the request fails, and the user retries - rather than half the group's history quietly
 * ceasing to exist.
 *
 * Both owner kinds use this. Characters are not exempt: the bulk migration that makes /save's
 * "tree state is assumed" comment true was a one-off run against one install's data, and nothing
 * committed would catch a character that was never part of it - a fresh install, a card restored
 * from a backup, anything that slipped through.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} params.ownerId Character avatar (without .png), or a group's own persistent id
 * @param {string} params.chatDir Directory holding this owner's chat files
 * @param {boolean} [params.isGroup]
 * @param {string[]|null} [params.fileNames] See migrateCharacterChats() - required for groups, whose
 * files cannot be identified by scanning `chatDir`
 * @returns {Promise<void>}
 */
export async function migrateOwnerOnTouch(directories, { ownerId, chatDir, isGroup = false, fileNames = null }) {
    await migrateCharacterChats(directories, ownerId, chatDir, isGroup, fileNames);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId Character avatar (without .png) or group ID
 * @param {string} chatDir Absolute path to the directory holding this owner's chat files
 * @param {boolean} isGroup
 * @param {string[]|null} [fileNames] Explicit list of file names within `chatDir` to migrate, for an
 * owner whose files can't be identified by scanning (groups - see step 2 of the algorithm above).
 * Names only, no path segments; entries naming a file that doesn't exist are dropped, since a
 * group's `chats` array outlives the files it points at. `null` means scan `chatDir` instead.
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

    // A scanned directory can only yield names that are already real entries in it. A caller-supplied
    // list cannot: it comes from a group descriptor, which is user-editable JSON that names chat ids
    // this process has never validated, and every name here goes on to be read from and renamed
    // inside chatDir. So the supplied list is held to what the scan would have produced anyway - a
    // bare .jsonl file name, no path segments, naming a file that actually exists - rather than
    // trusted. A stale entry (a chat id whose file is already gone) is ordinary, not an error: a
    // group's `chats` array outlives its files.
    const allFiles = (Array.isArray(fileNames)
        ? fileNames.filter(f => typeof f === 'string'
            && f.endsWith('.jsonl')
            && !f.includes('/') && !f.includes('\\') && path.basename(f) === f
            && fs.existsSync(path.join(chatDir, f)))
        : fs.readdirSync(chatDir).filter(f => f.endsWith('.jsonl'))
    ).sort();
    if (allFiles.length === 0) {
        return { migrated: 0, skipped: 0, errors: [] };
    }

    const errors = [];
    let migrated = 0;
    const migratedFileNames = [];
    /** Labels already handed out for this owner, so two files with the same name can't collide. */
    const usedLabels = new Set();

    // (parentId + '\0' + content) -> node id, for this owner, for this run.
    const index = new Map();

    db.transaction(() => {
        const now = Date.now();
        const anchor = ensureAnchorSync(db, ownerId, now);

        for (const fileName of allFiles) {
            const filePath = path.join(chatDir, fileName);
            let raw;
            try {
                raw = fs.readFileSync(filePath, 'utf8');
            } catch (err) {
                errors.push(`Failed to read ${fileName}: ${err.message}`);
                continue;
            }

            const lines = raw.split('\n').filter(Boolean);
            if (lines.length === 0) continue;

            let header;
            try {
                header = JSON.parse(lines[0]);
            } catch (err) {
                errors.push(`Failed to parse header of ${fileName}: ${err.message}`);
                continue;
            }

            const messages = [];
            for (let i = 1; i < lines.length; i++) {
                try { messages.push(JSON.parse(lines[i])); } catch { /* skip malformed line */ }
            }

            const chatName = fileName.replace(/\.jsonl$/, '');
            const cleanMetadata = { ...(header?.chat_metadata || {}) };
            // main_chat/fork_point described a relationship the tree derives from content directly.
            delete cleanMetadata.main_chat;
            delete cleanMetadata.fork_point;
            if (isGroup) cleanMetadata.__is_group = true;

            try {
                let parentId = anchor.id;
                let lastId = null;

                for (const msg of messages) {
                    const { contents, selected } = alternativesFromMessage(msg);
                    let chosenId = null;

                    for (let k = 0; k < contents.length; k++) {
                        const content = contents[k];
                        // Shared with every other ingest path, so the same chat arriving as
                        // JSONL or as a client save lands on exactly the same rows.
                        const key = nodeIdentityKey(parentId, content);
                        let id = index.get(key);
                        if (!id) {
                            id = newId();
                            insertMessageSync(db, {
                                id,
                                parentId,
                                ownerId,
                                content,
                                label: null,
                                // +k keeps sibling order == the file's swipe order under the
                                // (created_at, id) sort used everywhere in this schema.
                                createdAt: now + k,
                            });
                            index.set(key, id);
                        }
                        if (k === selected) chosenId = id;
                    }

                    // The file's own continuation hangs off the selected alternative, so that is what
                    // this parent shows by default. Set unconditionally: later files re-walking a
                    // shared prefix assert the same choice, so this converges rather than flapping.
                    setDefaultChildSync(db, parentId, chosenId);
                    parentId = chosenId;
                    lastId = chosenId;
                }

                if (lastId) {
                    // One label per node. If an earlier file already claimed this leaf, this file's
                    // name is dropped rather than overwriting — reported, never silent.
                    const existing = db.get('SELECT label FROM messages WHERE id = @id', { id: lastId });
                    if (existing?.label) {
                        errors.push(`Dropped duplicate chat name "${chatName}" — leaf already labeled "${existing.label}"`);
                    } else if (usedLabels.has(chatName)) {
                        errors.push(`Dropped duplicate chat name "${chatName}" — name already used by an earlier file`);
                    } else {
                        createBranchSync(db, {
                            leafId: lastId,
                            name: chatName,
                            isGroup,
                            metadata: JSON.stringify(cleanMetadata),
                        });
                        usedLabels.add(chatName);
                    }
                }

                migrated++;
                migratedFileNames.push(fileName);
            } catch (err) {
                errors.push(`Failed to migrate ${fileName}: ${err.message}`);
            }
        }
    });

    for (const fileName of migratedFileNames) {
        try {
            const filePath = path.join(chatDir, fileName);
            const preMigPath = filePath + '.pre-migration';
            if (!fs.existsSync(preMigPath)) fs.renameSync(filePath, preMigPath);
        } catch (err) {
            errors.push(`Failed to rename ${fileName}: ${err.message}`);
        }
    }

    const skipped = allFiles.length - migrated;
    console.log(color.green(`[message-tree] Migrated ${migrated} chats for ${ownerId} (${skipped} skipped, ${errors.length} errors)`));

    return { migrated, skipped, errors };
}
