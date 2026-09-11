import fs from 'node:fs';
import path from 'node:path';

import { color } from './util.js';
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
    const usedLabels = new Set();
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
            // the tree derives this relationship from content directly
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
                                // +k preserves swipe order under the (created_at, id) sort used elsewhere
                                createdAt: now + k,
                            });
                            index.set(key, id);
                        }
                        if (k === selected) chosenId = id;
                    }

                    // set unconditionally so re-walking a shared prefix converges rather than flapping
                    setDefaultChildSync(db, parentId, chosenId);
                    parentId = chosenId;
                    lastId = chosenId;
                }

                if (lastId) {
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
