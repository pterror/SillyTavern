import zlib from 'node:zlib';
import { promisify } from 'node:util';

import { chatPathNodeIds, getMessageTreeDb } from './message-tree-db.js';
import { clearItemizationsSync, deleteItemizationsSync, writeItemizationSync } from './itemization-rows.js';

const zstdCompress = promisify(zlib.zstdCompress);
const zstdDecompress = promisify(zlib.zstdDecompress);

/** How many times a merge is retried when another write to the same itemization lands while it is read. */
const MERGE_ATTEMPTS = 5;

/**
 * @typedef {Record<string, unknown>} Itemization A reply's prompt itemization: what the page's "Prompt" view reads.
 * Stored without `mesId`; the page gives an entry the position of its message when it reads one.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The itemization stored with a generated reply: what the page put into the prompt (sent with the generate request),
 * with the server's own breakdown of the prompt it built taking precedence.
 * @param {unknown} pagePart
 * @param {unknown} serverPart
 * @returns {Itemization | null} null when neither side has one.
 */
export function itemizationOf(pagePart, serverPart) {
    const page = isPlainObject(pagePart) ? pagePart : null;
    const server = isPlainObject(serverPart) ? serverPart : null;
    if (!page && !server) return null;
    const entry = { ...page, ...server };
    delete entry.mesId;
    return entry;
}

/**
 * @param {Itemization} entry
 * @returns {Promise<Buffer>}
 */
function encode(entry) {
    return zstdCompress(Buffer.from(JSON.stringify(entry)));
}

/**
 * @param {Uint8Array} data
 * @returns {Promise<Itemization>}
 */
async function decode(data) {
    return JSON.parse((await zstdDecompress(data)).toString('utf8'));
}

/**
 * @param {Uint8Array | undefined | null} a
 * @param {Uint8Array} b
 */
function sameBytes(a, b) {
    return a != null && Buffer.compare(Buffer.from(a), b) === 0;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} nodeId
 * @returns {Uint8Array | undefined}
 */
function storedBytesSync(db, nodeId) {
    return /** @type {{ data: Uint8Array } | undefined} */ (db.get('SELECT data FROM itemizations WHERE node_id = @nodeId', { nodeId }))?.data;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} nodeId
 */
function nodeExistsSync(db, nodeId) {
    return Boolean(db.get('SELECT 1 AS ok FROM messages WHERE id = @nodeId AND parent_id IS NOT NULL', { nodeId }));
}

/**
 * Stores a message's itemization, replacing the one it had. Writes nothing when it is the one stored.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} nodeId
 * @param {Itemization} entry
 * @returns {Promise<'written' | 'unchanged' | 'no-message'>}
 */
export async function recordItemization(directories, nodeId, entry) {
    const db = await getMessageTreeDb(directories);
    if (!db) throw new Error('the message store is unavailable');
    const stored = { ...entry };
    delete stored.mesId;
    const data = await encode(stored);
    if (!nodeExistsSync(db, nodeId)) return 'no-message';
    if (sameBytes(storedBytesSync(db, nodeId), data)) return 'unchanged';
    writeItemizationSync(db, nodeId, data, Boolean(stored.rawPrompt));
    return 'written';
}

/**
 * Changes some fields of a message's stored itemization. Writes nothing when they already have these values.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} nodeId
 * @param {Record<string, unknown>} fields
 * @returns {Promise<'written' | 'unchanged' | 'no-itemization'>}
 */
export async function updateItemizationFields(directories, nodeId, fields) {
    const db = await getMessageTreeDb(directories);
    if (!db) throw new Error('the message store is unavailable');
    for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
        const before = storedBytesSync(db, nodeId);
        if (before == null) return 'no-itemization';
        const merged = { ...await decode(before), ...fields };
        delete merged.mesId;
        const data = await encode(merged);
        // Compare-and-set: the itemization must still be the one merged into.
        const now = storedBytesSync(db, nodeId);
        if (now == null) return 'no-itemization';
        if (!sameBytes(now, Buffer.from(before))) continue;
        if (sameBytes(now, data)) return 'unchanged';
        writeItemizationSync(db, nodeId, data, Boolean(merged.rawPrompt));
        return 'written';
    }
    throw new Error('the itemization kept changing while it was being updated');
}

/**
 * A message's itemization, and the nearest message above it whose itemization holds the prompt as sent.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} nodeId
 * @returns {Promise<{ entry: Itemization, previous_node_id: string | null } | null>} null when it has none.
 */
export async function readItemization(directories, nodeId) {
    const db = await getMessageTreeDb(directories);
    if (!db) return null;
    const data = storedBytesSync(db, nodeId);
    if (data == null) return null;
    const previous = /** @type {{ id: string } | undefined} */ (db.get(`
        WITH RECURSIVE up(id, depth) AS (
            SELECT parent_id, 1 FROM messages WHERE id = @nodeId AND parent_id IS NOT NULL
            UNION ALL
            SELECT m.parent_id, up.depth + 1 FROM messages m JOIN up ON m.id = up.id WHERE m.parent_id IS NOT NULL
        )
        SELECT up.id FROM up JOIN itemizations i ON i.node_id = up.id
        WHERE i.has_raw_prompt = 1 ORDER BY up.depth LIMIT 1`, { nodeId }));
    return { entry: await decode(data), previous_node_id: previous?.id ?? null };
}

/**
 * The itemizations of a chat's messages, each with its message's position in the chat.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} ownerId
 * @param {string} chat A node id or chat name, as `/api/chats/open` takes one.
 * @returns {Promise<{ index: number, node_id: string, entry: Itemization }[] | null>} null when there is no such chat.
 */
export async function chatItemizations(directories, ownerId, chat) {
    const db = await getMessageTreeDb(directories);
    const ids = db ? await chatPathNodeIds(directories, ownerId, chat) : null;
    if (!db || !ids) return null;
    const out = [];
    for (let index = 0; index < ids.length; index++) {
        const data = storedBytesSync(db, ids[index]);
        if (data != null) out.push({ index, node_id: ids[index], entry: await decode(data) });
    }
    return out;
}

/**
 * Removes the itemizations of a chat's messages.
 * @param {import('./message-tree-db.js').Directories} directories
 * @param {string} ownerId
 * @param {string} chat A node id or chat name, as `/api/chats/open` takes one.
 * @returns {Promise<number | null>} How many were removed; null when there is no such chat.
 */
export async function deleteChatItemizations(directories, ownerId, chat) {
    const db = await getMessageTreeDb(directories);
    const ids = db ? await chatPathNodeIds(directories, ownerId, chat) : null;
    if (!db || !ids) return null;
    let removed = 0;
    db.transaction(() => {
        removed = 0;
        for (const nodeId of ids) removed += deleteItemizationsSync(db, [nodeId]);
    });
    return removed;
}

/**
 * Removes every itemization.
 * @param {import('./message-tree-db.js').Directories} directories
 */
export async function clearItemizations(directories) {
    const db = await getMessageTreeDb(directories);
    if (!db) throw new Error('the message store is unavailable');
    clearItemizationsSync(db);
}
