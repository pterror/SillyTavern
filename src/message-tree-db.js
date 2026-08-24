import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { color } from './util.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';

/**
 * Tree-structured message storage with parent pointers. Replaces flat JSONL-per-branch chat storage
 * with a SQLite-backed tree where shared message prefixes are stored exactly once, eliminating the
 * ~46% data duplication measured across a real install's 15K chat files / 460K messages.
 *
 * Each message is a row with a `parent_id` FK forming a tree. A "branch" (previously an independent
 * JSONL file) is now a named pointer to a leaf message — loading a branch reconstructs the root-to-leaf
 * path via recursive CTE, and forking is O(1) (insert one row, create one branch record) instead of
 * O(N) (copy N messages into a new file).
 *
 * Messages carry their full content as a JSON blob in the `content` column, same shape as a JSONL chat
 * line (mes, name, is_user, send_date, extra, swipes, etc.). The client-facing API is unchanged: load
 * returns a flat array (root-to-leaf path), save receives a flat array and diffs it against the tree.
 * The `node_id` field added to each message on load survives the client round-trip and lets the server
 * identify which messages in a save are already in the DB vs. new.
 *
 * Follows the same per-user-DB, getEntry()-gated, sync-inside-async-wrapper patterns that
 * chat-metadata-db.js established. The sqlite-engine.js abstraction handles native/WASM fallback.
 */

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        parent_id  TEXT REFERENCES messages(id),
        owner_id   TEXT NOT NULL,
        content    TEXT NOT NULL,
        label      TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_parent   ON messages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_owner    ON messages(owner_id);

    CREATE TABLE IF NOT EXISTS branches (
        id            TEXT PRIMARY KEY,
        owner_id      TEXT NOT NULL,
        leaf_id       TEXT NOT NULL REFERENCES messages(id),
        name          TEXT NOT NULL,
        is_group      INTEGER NOT NULL DEFAULT 0,
        metadata      TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_mes      TEXT,
        created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branches_owner      ON branches(owner_id);
    CREATE INDEX IF NOT EXISTS idx_branches_owner_name  ON branches(owner_id, name);

    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
`;

/** SQL to walk from a leaf to the root via recursive CTE, returning the path in root-to-leaf order. */
const PATH_CTE_SQL = `
    WITH RECURSIVE path(id, parent_id, owner_id, content, label, created_at, depth) AS (
        SELECT id, parent_id, owner_id, content, label, created_at, 0
        FROM messages WHERE id = @leafId
        UNION ALL
        SELECT m.id, m.parent_id, m.owner_id, m.content, m.label, m.created_at, p.depth + 1
        FROM messages m JOIN path p ON m.id = p.parent_id
    )
    SELECT id, parent_id, owner_id, content, label, created_at FROM path ORDER BY depth DESC
`;

// ---------------------------------------------------------------------------
//  Per-user DB handles (same pattern as chat-metadata-db.js)
// ---------------------------------------------------------------------------

/** @type {Map<string, { db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle }>} */
const entries = new Map();
let warnedNoEngine = false;

/** @param {import('./users.js').UserDirectoryList} directories */
function getDbPath(directories) {
    return path.join(directories.root, 'message-tree.sqlite');
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle } | null>}
 */
async function getEntry(directories) {
    const key = directories.root;
    const existing = entries.get(key);
    if (existing) return existing;

    const engine = await getSqliteEngine();
    if (!engine) {
        if (!warnedNoEngine) {
            warnedNoEngine = true;
            console.error(color.red('[message-tree] No usable SQLite backend — tree storage unavailable, falling back to JSONL.'));
        }
        return null;
    }

    if (!fs.existsSync(directories.root)) {
        fs.mkdirSync(directories.root, { recursive: true });
    }
    const db = engine.openDatabase(getDbPath(directories));
    db.exec(SCHEMA_SQL);
    const entry = { db };
    entries.set(key, entry);
    return entry;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function newId() {
    return crypto.randomUUID();
}

/**
 * Strips tree-internal and branch-specific fields from a message object before storing it. The stored
 * content is the canonical message shape (mes, name, is_user, send_date, extra, swipes, etc.) without
 * fields that the tree structure itself encodes (node_id, extra.branches, extra.bookmark_link).
 * @param {object} msg
 * @returns {string} JSON string of the sanitized message
 */
function sanitizeForStorage(msg) {
    const clone = { ...msg };
    delete clone.node_id;

    if (clone.extra && typeof clone.extra === 'object') {
        clone.extra = { ...clone.extra };
        // branches are now implicit in the tree (children of a message)
        delete clone.extra.branches;
        // bookmark_link becomes the label column on the messages table
        delete clone.extra.bookmark_link;
    }

    return JSON.stringify(clone);
}

/**
 * Parses a stored message row's content JSON and attaches the node_id for client round-tripping.
 * @param {{ id: string, content: string, label: string | null }} row
 * @returns {object} Message object with node_id
 */
function rowToMessage(row) {
    const msg = JSON.parse(row.content);
    msg.node_id = row.id;
    // Restore label as bookmark_link in extra for backward-compat with client UI
    if (row.label) {
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        msg.extra.bookmark_link = row.label;
    }
    return msg;
}

/**
 * Extracts the preview text from a message content string (same logic as chat-metadata-db.js).
 * @param {string} contentJson
 * @returns {string | null}
 */
function extractLastMes(contentJson) {
    try {
        const msg = JSON.parse(contentJson);
        return msg?.mes || null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
//  Core message operations (synchronous, operate on a db handle)
// ---------------------------------------------------------------------------

/**
 * Inserts a single message row.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ id: string, parentId: string | null, ownerId: string, content: string, label?: string | null, createdAt: number }} params
 */
function insertMessageSync(db, { id, parentId, ownerId, content, label, createdAt }) {
    db.run(
        `INSERT INTO messages (id, parent_id, owner_id, content, label, created_at)
         VALUES (@id, @parentId, @ownerId, @content, @label, @createdAt)`,
        { id, parentId: parentId ?? null, ownerId, content, label: label ?? null, createdAt },
    );
}

/**
 * Updates a message's content blob.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {string} content JSON string
 */
function updateMessageContentSync(db, id, content) {
    db.run('UPDATE messages SET content = @content WHERE id = @id', { id, content });
}

/**
 * Updates a message's label (checkpoint/pin name).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @param {string | null} label
 */
function labelMessageSync(db, id, label) {
    db.run('UPDATE messages SET label = @label WHERE id = @id', { id, label });
}

/**
 * Walks from `leafId` to the root, returning messages in root-to-leaf order.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} leafId
 * @returns {{ id: string, parent_id: string | null, owner_id: string, content: string, label: string | null, created_at: number }[]}
 */
function getPathSync(db, leafId) {
    return db.all(PATH_CTE_SQL, { leafId });
}

/**
 * Returns immediate children of a message.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} messageId
 * @returns {{ id: string, parent_id: string | null, content: string, label: string | null }[]}
 */
function getChildrenSync(db, messageId) {
    return db.all('SELECT id, parent_id, content, label FROM messages WHERE parent_id = @messageId', { messageId });
}

// ---------------------------------------------------------------------------
//  Branch operations (synchronous)
// ---------------------------------------------------------------------------

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ id: string, ownerId: string, leafId: string, name: string, isGroup?: boolean, metadata?: string | null, messageCount?: number, lastMes?: string | null, createdAt: number }} params
 */
function createBranchSync(db, { id, ownerId, leafId, name, isGroup, metadata, messageCount, lastMes, createdAt }) {
    db.run(
        `INSERT INTO branches (id, owner_id, leaf_id, name, is_group, metadata, message_count, last_mes, created_at)
         VALUES (@id, @ownerId, @leafId, @name, @isGroup, @metadata, @messageCount, @lastMes, @createdAt)`,
        {
            id,
            ownerId,
            leafId,
            name,
            isGroup: isGroup ? 1 : 0,
            metadata: metadata ?? null,
            messageCount: messageCount ?? 0,
            lastMes: lastMes ?? null,
            createdAt,
        },
    );
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} branchId
 * @param {string} leafId
 * @param {number} messageCount
 * @param {string | null} lastMes
 */
function updateBranchLeafSync(db, branchId, leafId, messageCount, lastMes) {
    db.run(
        'UPDATE branches SET leaf_id = @leafId, message_count = @messageCount, last_mes = @lastMes WHERE id = @branchId',
        { branchId, leafId, messageCount, lastMes },
    );
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} branchId
 * @param {string} metadata JSON string
 */
function updateBranchMetadataSync(db, branchId, metadata) {
    db.run('UPDATE branches SET metadata = @metadata WHERE id = @branchId', { branchId, metadata });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @param {string} name
 * @returns {object | undefined}
 */
function getBranchByNameSync(db, ownerId, name) {
    return db.get('SELECT * FROM branches WHERE owner_id = @ownerId AND name = @name', { ownerId, name });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} branchId
 * @returns {object | undefined}
 */
function getBranchByIdSync(db, branchId) {
    return db.get('SELECT * FROM branches WHERE id = @branchId', { branchId });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @returns {object[]}
 */
function listBranchesSync(db, ownerId) {
    return db.all('SELECT * FROM branches WHERE owner_id = @ownerId ORDER BY created_at ASC', { ownerId });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} branchId
 */
function deleteBranchSync(db, branchId) {
    db.run('DELETE FROM branches WHERE id = @branchId', { branchId });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} branchId
 * @param {string} newName
 */
function renameBranchSync(db, branchId, newName) {
    db.run('UPDATE branches SET name = @newName WHERE id = @branchId', { branchId, newName });
}

/**
 * Checks whether any branches exist for this owner.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @returns {boolean}
 */
function hasBranchesSync(db, ownerId) {
    const row = db.get('SELECT 1 FROM branches WHERE owner_id = @ownerId LIMIT 1', { ownerId });
    return !!row;
}

// ---------------------------------------------------------------------------
//  Fork-point / sibling detection
// ---------------------------------------------------------------------------

/**
 * Finds all branches whose leaf-to-root path passes through any child of `messageId`.
 * Used for branch-sibling navigation at fork points.
 *
 * Strategy: walk the subtree below `messageId` using a recursive CTE, then find all branches whose
 * leaf is in that subtree. Group by which immediate child of `messageId` they descend through.
 *
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} messageId
 * @returns {{ childId: string, branches: object[] }[]}
 */
function getForkSiblingsSync(db, messageId) {
    // First get immediate children
    const children = getChildrenSync(db, messageId);
    if (children.length === 0) return [];

    // For each child, find all branches whose path descends through it
    const result = [];
    for (const child of children) {
        const branches = db.all(`
            WITH RECURSIVE subtree(id) AS (
                SELECT @childId
                UNION ALL
                SELECT m.id FROM messages m JOIN subtree s ON m.parent_id = s.id
            )
            SELECT b.* FROM branches b WHERE b.leaf_id IN (SELECT id FROM subtree)
        `, { childId: child.id });

        // Also check: is this child itself a branch leaf (the branch that continues the conversation)?
        // A branch whose leaf IS the fork point message means that branch ends at the fork.
        // These are included in the result naturally since the subtree walk starts at the child.

        if (branches.length > 0) {
            result.push({ childId: child.id, branches });
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
//  High-level exported operations (async, take directories)
// ---------------------------------------------------------------------------

/**
 * Checks if the tree DB is available for this user.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<boolean>}
 */
export async function isAvailable(directories) {
    const entry = await getEntry(directories);
    return !!entry;
}

/**
 * Checks if a character/group has been migrated into the tree DB.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @returns {Promise<boolean>}
 */
export async function isMigrated(directories, ownerId) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return hasBranchesSync(entry.db, ownerId);
}

/**
 * Loads a branch as a flat message array (same format the client expects), with node_id on each
 * message for round-trip identification. Returns null if the branch doesn't exist.
 *
 * The returned array does NOT include the chat_metadata header (element 0 of the JSONL format) —
 * that's stored on the branch record and returned separately. The caller is responsible for
 * assembling [header, ...messages] before sending to the client.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @param {string} branchName
 * @returns {Promise<{ messages: object[], metadata: object, branch: object } | null>}
 */
export async function loadBranch(directories, ownerId, branchName) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const branch = getBranchByNameSync(entry.db, ownerId, branchName);
    if (!branch) return null;

    const path = getPathSync(entry.db, branch.leaf_id);
    const messages = path.map(rowToMessage);

    // Reconstruct extra.branches for fork-point display on each message that has children
    for (let i = 0; i < path.length; i++) {
        const children = getChildrenSync(entry.db, path[i].id);
        if (children.length > 1 || (children.length === 1 && i < path.length - 1 && children[0].id !== path[i + 1]?.id)) {
            // This message has children that aren't just the next message in this branch's path.
            // It's a fork point. Reconstruct extra.branches for the client.
            // In the old model, branches were keyed by swipe_id. In the tree model, we group by
            // the child message's content (specifically, which swipe was active at fork time).
            // For now, use a flat "0" key (default swipe) for all children.
            if (!messages[i].extra || typeof messages[i].extra !== 'object') {
                messages[i].extra = {};
            }

            // Find branches that go through each child (not through this branch's own next message)
            const forkSiblings = getForkSiblingsSync(entry.db, path[i].id);
            const branchNames = {};
            for (const { branches: sibBranches } of forkSiblings) {
                for (const b of sibBranches) {
                    if (b.name !== branchName) {
                        // Key by swipe id — use "0" as default since the tree doesn't track per-swipe forks yet
                        const key = '0';
                        if (!branchNames[key]) branchNames[key] = [];
                        if (!branchNames[key].includes(b.name)) {
                            branchNames[key].push(b.name);
                        }
                    }
                }
            }
            if (Object.keys(branchNames).length > 0) {
                messages[i].extra.branches = branchNames;
            }
        }
    }

    const metadata = branch.metadata ? JSON.parse(branch.metadata) : {};

    return { messages, metadata, branch };
}

/**
 * Saves a chat array to the tree DB, handling the diff against existing state. This is the
 * transparent replacement for the JSONL file write — the client sends the same chat array format
 * it always has, and this function figures out what changed.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId Character avatar (without .png) or group ID
 * @param {string} chatName Chat/branch name (the JSONL filename without extension)
 * @param {object[]} chatData Full chat array: [header, message0, message1, ...] — same format as JSONL.
 *   Messages may be full content objects OR lightweight stubs `{ node_id: "...", _unchanged: true }`
 *   (the slim wire protocol — client sends stubs for messages whose content hasn't changed since
 *   the last load/save, reducing payload from O(total messages) to O(changed messages)).
 * @param {boolean} isGroup Whether this is a group chat
 * @returns {Promise<{ integrity?: string, assignedNodeIds?: { index: number, node_id: string }[] } | null>}
 *   null if tree DB unavailable. `assignedNodeIds` maps message indices (0-based, within the message
 *   array, NOT the chatData array) to their newly assigned node_ids — the client must write these back
 *   into the chat array so subsequent saves can identify them as existing (prevents duplicate inserts).
 */
export async function saveChatToTree(directories, ownerId, chatName, chatData, isGroup = false) {
    const t0 = performance.now();
    const entry = await getEntry(directories);
    if (!entry) return null;

    if (!Array.isArray(chatData) || chatData.length === 0) return null;

    const header = chatData[0];
    const messages = chatData.slice(1);
    const metadata = header?.chat_metadata || {};

    // Rotate integrity slug (same as trySaveChat does for JSONL)
    const nextIntegrity = crypto.randomUUID();
    metadata.integrity = nextIntegrity;
    // Strip tree-implicit metadata
    delete metadata.main_chat;
    delete metadata.fork_point;
    delete metadata._tree_stored; // Client-only flag, don't persist

    const metadataJson = JSON.stringify(metadata);

    const now = Date.now();
    const branch = getBranchByNameSync(entry.db, ownerId, chatName);

    /** @type {{ index: number, node_id: string }[]} */
    const assignedNodeIds = [];

    if (!branch) {
        // New branch — insert all messages and create branch record
        entry.db.transaction(() => {
            let parentId = null;
            let lastId = null;

            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                // Stubs in a new branch shouldn't happen, but handle gracefully: skip
                if (msg._unchanged) continue;

                const id = msg.node_id || newId();
                if (!msg.node_id) {
                    assignedNodeIds.push({ index: i, node_id: id });
                }
                const content = sanitizeForStorage(msg);
                insertMessageSync(entry.db, {
                    id,
                    parentId,
                    ownerId,
                    content,
                    label: msg.extra?.bookmark_link || null,
                    createdAt: now,
                });
                parentId = id;
                lastId = id;
            }

            if (lastId) {
                const lastFullMsg = messages.filter(m => !m._unchanged).pop();
                createBranchSync(entry.db, {
                    id: newId(),
                    ownerId,
                    leafId: lastId,
                    name: chatName,
                    isGroup,
                    metadata: metadataJson,
                    messageCount: messages.length,
                    lastMes: lastFullMsg ? extractLastMes(sanitizeForStorage(lastFullMsg)) : null,
                    createdAt: now,
                });
            }
        });

        const tDone = performance.now();
        console.debug(`[save-perf] saveChatToTree (new branch): messages=${messages.length} inserted=${assignedNodeIds.length} total=${(tDone - t0).toFixed(1)}ms`);
        return { integrity: nextIntegrity, assignedNodeIds };
    }

    // Existing branch — check for the fast append-only path first.
    // When every existing message is an unchanged stub and only new messages (no node_id) appear
    // at the tail, we can skip the O(N) recursive CTE entirely: just INSERT the new rows chained
    // off branch.leaf_id and UPDATE the branch pointer.
    const tPreDiff = performance.now();

    // Find the index where new (non-stub, no node_id) messages begin at the tail
    let appendStart = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._unchanged || messages[i].node_id) break;
        appendStart = i;
    }
    const hasNewTail = appendStart < messages.length;
    const allPrecedingAreStubs = hasNewTail && messages.slice(0, appendStart).every(m => m._unchanged && m.node_id);

    if (hasNewTail && allPrecedingAreStubs) {
        // Fast path: pure append — skip the recursive CTE
        entry.db.transaction(() => {
            let parentId = branch.leaf_id;
            for (let i = appendStart; i < messages.length; i++) {
                const msg = messages[i];
                const id = newId();
                assignedNodeIds.push({ index: i, node_id: id });
                const content = sanitizeForStorage(msg);
                insertMessageSync(entry.db, {
                    id,
                    parentId,
                    ownerId,
                    content,
                    label: msg.extra?.bookmark_link || null,
                    createdAt: now,
                });
                parentId = id;
            }
            const lastMsg = messages[messages.length - 1];
            const lastMes = extractLastMes(sanitizeForStorage(lastMsg));
            updateBranchLeafSync(entry.db, branch.id, parentId, messages.length, lastMes);
            updateBranchMetadataSync(entry.db, branch.id, metadataJson);
        });

        const tDone = performance.now();
        const newCount = messages.length - appendStart;
        console.debug(`[save-perf] saveChatToTree (append fast path): messages=${messages.length} appended=${newCount} total=${(tDone - t0).toFixed(1)}ms`);
        return { integrity: nextIntegrity, assignedNodeIds };
    }

    // Full diff path — need the recursive CTE to resolve existing messages
    entry.db.transaction(() => {
        const currentPath = getPathSync(entry.db, branch.leaf_id);

        // Build lookup: node_id → index in current path
        const nodeIdToPathIdx = new Map();
        for (let i = 0; i < currentPath.length; i++) {
            nodeIdToPathIdx.set(currentPath[i].id, i);
        }

        let lastNodeId = null;
        let messageCount = 0;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            messageCount++;

            // Stub: unchanged message — skip all processing, just track position
            if (msg._unchanged && msg.node_id && nodeIdToPathIdx.has(msg.node_id)) {
                lastNodeId = msg.node_id;
                continue;
            }

            if (msg.node_id && nodeIdToPathIdx.has(msg.node_id)) {
                // Existing message with full content — check if content changed
                const existingRow = currentPath[nodeIdToPathIdx.get(msg.node_id)];
                const newContent = sanitizeForStorage(msg);
                if (existingRow.content !== newContent) {
                    updateMessageContentSync(entry.db, msg.node_id, newContent);
                }
                // Check if label changed
                const newLabel = msg.extra?.bookmark_link || null;
                if (existingRow.label !== newLabel) {
                    labelMessageSync(entry.db, msg.node_id, newLabel);
                }
                lastNodeId = msg.node_id;
            } else {
                // New message — insert with parent = lastNodeId
                const id = newId();
                assignedNodeIds.push({ index: i, node_id: id });
                const content = sanitizeForStorage(msg);
                insertMessageSync(entry.db, {
                    id,
                    parentId: lastNodeId,
                    ownerId,
                    content,
                    label: msg.extra?.bookmark_link || null,
                    createdAt: now,
                });
                lastNodeId = id;
            }
        }

        // Update branch leaf pointer and cached metadata
        if (lastNodeId && lastNodeId !== branch.leaf_id) {
            // Find last full message for preview (stubs don't have content)
            const lastFullIdx = messages.reduceRight((found, m, idx) => found >= 0 ? found : (m._unchanged ? -1 : idx), -1);
            const lastMes = lastFullIdx >= 0 ? extractLastMes(sanitizeForStorage(messages[lastFullIdx])) : branch.last_mes;
            updateBranchLeafSync(entry.db, branch.id, lastNodeId, messageCount, lastMes);
        } else if (messageCount !== branch.message_count) {
            const lastFullIdx = messages.reduceRight((found, m, idx) => found >= 0 ? found : (m._unchanged ? -1 : idx), -1);
            const lastMes = lastFullIdx >= 0 ? extractLastMes(sanitizeForStorage(messages[lastFullIdx])) : branch.last_mes;
            updateBranchLeafSync(entry.db, branch.id, lastNodeId || branch.leaf_id, messageCount, lastMes);
        }

        // Always update metadata (it might have changed even if messages didn't)
        updateBranchMetadataSync(entry.db, branch.id, metadataJson);
    });

    const tDone = performance.now();
    const stubCount = messages.filter(m => m._unchanged).length;
    const insertCount = assignedNodeIds.length;
    const updateCount = messages.length - stubCount - insertCount;
    console.debug(`[save-perf] saveChatToTree (full diff): messages=${messages.length} stubs=${stubCount} inserts=${insertCount} updates=${updateCount} diffSetup=${(tPreDiff - t0).toFixed(1)}ms transaction=${(tDone - tPreDiff).toFixed(1)}ms total=${(tDone - t0).toFixed(1)}ms`);
    return { integrity: nextIntegrity, assignedNodeIds };
}

/**
 * Creates a fork: a new branch that shares the path up to `forkAtNodeId` and then diverges.
 * This is the O(1) replacement for the old "copy N messages into a new file" fork.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @param {string} forkAtNodeId The message node_id to fork at (the new branch starts here)
 * @param {string} newBranchName Name for the new branch
 * @param {boolean} isGroup
 * @param {object} [metadata] Chat metadata for the new branch
 * @returns {Promise<{ branchId: string, branchName: string } | null>}
 */
export async function forkBranch(directories, ownerId, forkAtNodeId, newBranchName, isGroup = false, metadata = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    // Verify the message exists
    const msg = entry.db.get('SELECT id FROM messages WHERE id = @id', { id: forkAtNodeId });
    if (!msg) return null;

    const branchId = newId();
    const now = Date.now();

    // Count messages from root to fork point
    const pathToFork = getPathSync(entry.db, forkAtNodeId);
    const messageCount = pathToFork.length;
    const lastMes = messageCount > 0 ? extractLastMes(pathToFork[pathToFork.length - 1].content) : null;

    // Strip tree-implicit fields from metadata
    const cleanMetadata = { ...metadata };
    delete cleanMetadata.main_chat;
    delete cleanMetadata.fork_point;
    cleanMetadata.integrity = crypto.randomUUID();

    entry.db.transaction(() => {
        createBranchSync(entry.db, {
            id: branchId,
            ownerId,
            leafId: forkAtNodeId,
            name: newBranchName,
            isGroup,
            metadata: JSON.stringify(cleanMetadata),
            messageCount,
            lastMes,
            createdAt: now,
        });
    });

    return { branchId, branchName: newBranchName };
}

/**
 * Lists all branches for a character/group, returning the metadata needed for the chat selector UI.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @returns {Promise<object[]>}
 */
export async function listBranches(directories, ownerId) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return listBranchesSync(entry.db, ownerId);
}

/**
 * Deletes a branch record. Does NOT delete shared messages (they might be used by other branches).
 * Orphaned messages (not reachable from any branch) can be cleaned up separately.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @param {string} branchName
 * @returns {Promise<boolean>} true if a branch was found and deleted
 */
export async function deleteBranch(directories, ownerId, branchName) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const branch = getBranchByNameSync(entry.db, ownerId, branchName);
    if (!branch) return false;

    deleteBranchSync(entry.db, branch.id);
    return true;
}

/**
 * Renames a branch.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @param {string} oldName
 * @param {string} newName
 * @returns {Promise<boolean>}
 */
export async function renameBranch(directories, ownerId, oldName, newName) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const branch = getBranchByNameSync(entry.db, ownerId, oldName);
    if (!branch) return false;

    renameBranchSync(entry.db, branch.id, newName);
    return true;
}

/**
 * Labels (pins/checkpoints) a message node. Pass null to remove the label.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} nodeId
 * @param {string | null} label
 * @returns {Promise<boolean>}
 */
export async function labelNode(directories, nodeId, label) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const msg = entry.db.get('SELECT id FROM messages WHERE id = @id', { id: nodeId });
    if (!msg) return false;

    labelMessageSync(entry.db, nodeId, label);
    return true;
}

/**
 * Resolves the fork ring at a given message node — all branches that share this node as part of
 * their path, grouped by which direction they go after this node.
 *
 * Returns an array where each element is a group of branches that share the same immediate child
 * of the given message. The current branch is identified by name so the caller can find its position.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} nodeId
 * @returns {Promise<{ childId: string, branches: { id: string, name: string }[] }[] | null>}
 */
export async function getForkRing(directories, nodeId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    return getForkSiblingsSync(entry.db, nodeId);
}

/**
 * Returns the direct access to the db handle for migration (which needs to do many operations
 * inside a single transaction for performance). Not for general use.
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<import('./endpoints/sqlite-engine.js').SqliteEngineHandle | null>}
 */
export async function getDbHandle(directories) {
    const entry = await getEntry(directories);
    return entry ? entry.db : null;
}

/**
 * Renames the character name inside all messages for an owner, directly in the DB.
 * Replaces the client-side renamePastChats round-trip-per-chat approach with a single
 * SQL UPDATE that touches only the rows that need changing.
 *
 * Only renames character messages (is_user=false, not system/narrator) — same filter
 * the old client-side loop applied.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @param {string} newName
 * @returns {Promise<number>} Number of messages updated
 */
export async function renameCharacterInMessages(directories, ownerId, newName) {
    const entry = await getEntry(directories);
    if (!entry) return 0;

    // Find all messages for this owner where name differs and message is a character message
    // (not user, not system, not narrator). We parse the JSON content to check these fields,
    // update the name, and write back.
    const rows = entry.db.all(
        `SELECT id, content FROM messages
         WHERE owner_id = @ownerId
           AND json_extract(content, '$.is_user') IS NOT 1
           AND json_extract(content, '$.is_system') IS NOT 1
           AND COALESCE(json_extract(content, '$.extra.type'), '') != 'narrator'
           AND json_extract(content, '$.name') IS NOT @newName`,
        { ownerId, newName },
    );

    if (rows.length === 0) return 0;

    let updated = 0;
    entry.db.transaction(() => {
        for (const row of rows) {
            try {
                const msg = JSON.parse(row.content);
                msg.name = newName;
                // Also update the name inside swipes' swipe_info if present
                entry.db.run(
                    'UPDATE messages SET content = @content WHERE id = @id',
                    { id: row.id, content: JSON.stringify(msg) },
                );
                updated++;
            } catch {
                // Skip malformed content rows
            }
        }
    });

    return updated;
}

// Re-export internal helpers needed by the migration module
export { insertMessageSync, createBranchSync, getPathSync, getBranchByNameSync, hasBranchesSync, newId, sanitizeForStorage, extractLastMes };

/**
 * Closes all open DB handles — test cleanup.
 */
export function disposeMessageTreeStores() {
    for (const entry of entries.values()) {
        try { entry.db.close(); } catch { /* best-effort */ }
    }
    entries.clear();
}
