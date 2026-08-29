import fs from 'node:fs';
import path from 'node:path';

import { color } from './util.js';
import {
    getDbHandle, insertMessageSync, createBranchSync,
    hasBranchesSync, newId, sanitizeForStorage, extractLastMes,
} from './message-tree-db.js';

/**
 * Migrates a character's JSONL chat files into the message tree DB, deduplicating shared message
 * history across files. Called lazily on first access to a character's chats (not at startup) so
 * only active characters pay the migration cost.
 *
 * Algorithm:
 * 1. Read all .jsonl files in the character's chat directory, in a deterministic (sorted) order.
 * 2. For each file, walk its messages in order. At each step, the message's identity is
 *    (parent node id, exact sanitized content) - if a node with that exact identity already
 *    exists for this owner (inserted earlier in this same run, by this file or an earlier one),
 *    reuse it instead of inserting a new row; otherwise insert a new row and index it.
 * 3. Create the branch record for each file, pointing at the last node reached by its walk.
 * 4. After successful migration, rename .jsonl files to .jsonl.pre-migration.
 *
 * This does NOT depend on chat_metadata.main_chat/fork_point at all - those were the old
 * migration's way of approximating "these files share history" without actually comparing
 * content, which meant any copy that predated that metadata (or lost it) never got deduplicated,
 * no matter how much of its history was identical to another file's. Comparing content directly
 * is a strictly better signal: it catches every case main_chat did, plus every untracked copy,
 * with no dependency on a pointer that can be missing, stale, or simply never have existed.
 * File processing order no longer affects correctness (any order converges to the same tree,
 * modulo which literal row id ends up canonical for a shared prefix) - it's kept deterministic
 * (sorted by file name) purely so repeated runs behave predictably, not because order matters.
 *
 * Idempotent: a character with any existing branches is skipped entirely (hasBranchesSync gate)
 * and the whole migration for one owner runs as a single transaction, so a crash mid-run leaves
 * nothing partially committed - the next attempt starts clean rather than needing to reconcile
 * partial state.
 */

/**
 * Migrates all chats for a single character/group into the tree DB.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId Character avatar (without .png) or group ID
 * @param {string} chatDir Absolute path to the character's chat directory
 * @param {boolean} isGroup
 * @returns {Promise<{ migrated: number, skipped: number, errors: string[] }>}
 */
export async function migrateCharacterChats(directories, ownerId, chatDir, isGroup = false) {
    const db = await getDbHandle(directories);
    if (!db) return { migrated: 0, skipped: 0, errors: ['No SQLite backend available'] };

    // Already migrated?
    if (hasBranchesSync(db, ownerId)) {
        return { migrated: 0, skipped: 0, errors: [] };
    }

    if (!fs.existsSync(chatDir)) {
        return { migrated: 0, skipped: 0, errors: [] };
    }

    const allFiles = fs.readdirSync(chatDir).filter(f => f.endsWith('.jsonl')).sort();
    if (allFiles.length === 0) {
        return { migrated: 0, skipped: 0, errors: [] };
    }

    const errors = [];
    let migrated = 0;
    const migratedFileNames = [];

    // Identity index for this owner: (parentId ?? 'ROOT') + ' ' + sanitized-content -> node id.
    // Starts empty - hasBranchesSync already gated out owners with any existing tree content, so
    // there is nothing to seed it from. Populated as messages are inserted, so a later file in
    // this same run transparently reuses rows an earlier file already created.
    const index = new Map();

    db.transaction(() => {
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
                try {
                    messages.push(JSON.parse(lines[i]));
                } catch {
                    // Skip malformed message lines
                }
            }

            const chatName = fileName.replace('.jsonl', '');
            const metadata = header?.chat_metadata || {};
            // Strip fields that are now implicit in the tree - main_chat/fork_point described a
            // relationship the old migration needed to be told about; the tree derives the same
            // relationship (and more, since it also catches untracked copies) from content alone.
            const cleanMetadata = { ...metadata };
            delete cleanMetadata.main_chat;
            delete cleanMetadata.fork_point;

            const now = Date.now();
            let parentId = null;
            const nodeIds = [];

            try {
                for (const msg of messages) {
                    const content = sanitizeForStorage(msg);
                    const key = (parentId ?? 'ROOT') + ' ' + content;
                    let id = index.get(key);
                    if (!id) {
                        id = newId();
                        insertMessageSync(db, {
                            id,
                            parentId,
                            ownerId,
                            content,
                            label: msg.extra?.bookmark_link || null,
                            createdAt: now,
                        });
                        index.set(key, id);
                    }
                    nodeIds.push(id);
                    parentId = id;
                }

                const leafId = nodeIds.length > 0 ? nodeIds[nodeIds.length - 1] : null;
                if (leafId) {
                    const lastMes = messages.length > 0 ? extractLastMes(sanitizeForStorage(messages[messages.length - 1])) : null;
                    createBranchSync(db, {
                        id: newId(),
                        ownerId,
                        leafId,
                        name: chatName,
                        isGroup,
                        metadata: JSON.stringify(cleanMetadata),
                        messageCount: nodeIds.length,
                        lastMes,
                        createdAt: now,
                    });
                }

                migrated++;
                migratedFileNames.push(fileName);
            } catch (err) {
                errors.push(`Failed to migrate ${fileName}: ${err.message}`);
            }
        }
    });

    // Rename migrated files (outside the transaction — DB changes are committed even if rename fails)
    for (const fileName of migratedFileNames) {
        try {
            const filePath = path.join(chatDir, fileName);
            const preMigPath = filePath + '.pre-migration';
            if (!fs.existsSync(preMigPath)) {
                fs.renameSync(filePath, preMigPath);
            }
        } catch (err) {
            errors.push(`Failed to rename ${fileName}: ${err.message}`);
        }
    }

    const skipped = allFiles.length - migrated;
    console.log(color.green(`[message-tree] Migrated ${migrated} chats for ${ownerId} (${skipped} skipped, ${errors.length} errors)`));

    return { migrated, skipped, errors };
}
